/**
 * The hooks engine: loads every source through its adapter, keeps the
 * canonical table, and turns one HookBus emit into a chain result.
 *
 * It never branches on a dialect id, except that native is pinned first by
 * the registry. See SPEC.md "Engine execution".
 *
 * @module engine/engine
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import {
  resolveAgentHome,
  resolveSessionsDir,
} from "@minimal-agent/core/plugin-api/utils/agent-paths"

import { AsyncHookQueue } from "./async-queue.ts"
import { channelInfo, rewritableKeys } from "./channels.ts"
import { defaultHooksConfig, type HooksConfig } from "./config.ts"
import { dedupHooks, type MergedResult, mergeResults } from "./merge.ts"
import { capText } from "./output-cap.ts"
import { findProjectRoot } from "./project.ts"
import { selectAdapters } from "./registry.ts"
import { runHandler } from "./runner.ts"
import { type TrustState, TrustStore, type TrustVerdict, trustStatePath } from "./trust.ts"
import type {
  CanonicalHook,
  CanonicalResult,
  HookContextEntry,
  HookDialectAdapter,
  InvocationContext,
  ParseResult,
  PluginRef,
  SourceRef,
} from "./types.ts"

type Env = Readonly<Record<string, string | undefined>>

/** Options of {@link HooksEngine}. */
export interface EngineOptions {
  cwd: string
  /** Default `process.env`. Reads `HOME`, `MINIMAL_AGENT_HOME`, `MA_TRUST_HOOKS`. */
  env?: Env
  config?: HooksConfig
  /** Default: `selectAdapters(config)` (native first). */
  adapters?: HookDialectAdapter[]
  plugins?: PluginRef[]
  /** Diagnostic sink. */
  log?: (msg: string) => void
  /** Debug sink (ignored fields and other low-value notes). */
  debug?: (msg: string) => void
  /** Shared async queue (keyed by session), so a rebuilt engine keeps queued output. */
  asyncQueue?: AsyncHookQueue
}

/** One diagnostic record per hook run (SPEC.md user story 57). */
export interface RunRecord {
  dialect: string
  channel: string
  trustKey: string
  exitCode: number | null
  durationMs: number
  decision: CanonicalResult["decision"]
  error?: string
}

/** One loaded source with its parse warnings. */
export interface LoadedSource {
  adapter: string
  source: SourceRef
  exists: boolean
  warnings: string[]
}

/** Values the HookBus listener returns (core chain contract plus additionalContext). */
export type EngineChainResult =
  | undefined
  | { payload: unknown; additionalContext?: HookContextEntry[] }
  | { halt: true; reason: string; payload?: unknown; additionalContext?: HookContextEntry[] }

/** Channels where a context position matters (core HookContextEntry contract). */
const POSITION_CHANNELS: ReadonlySet<string> = new Set(["turn.willStart", "session.willStart"])

/**
 * The additionalContext list for one channel. On a position channel a
 * `before` entry is a `{ text, position: "before" }` object, and comes first.
 * An `after` entry is always a plain string (the contract: a string means
 * after), so with no `before` hooks the shape is the same as before P2 and
 * a core that keeps only string items loses nothing.
 */
export function contextEntries(
  channel: string,
  before: readonly string[],
  after: readonly string[],
): HookContextEntry[] {
  if (!POSITION_CHANNELS.has(channel)) return [...before, ...after]
  return [...before.map((text): HookContextEntry => ({ text, position: "before" })), ...after]
}

/** Extra per-call values from the hook handler context. */
export interface DispatchContext {
  sid?: string
  cwd?: string
  abort?: AbortSignal
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/** Disable switches collected while loading. `project*` never touch user hooks. */
class Switches {
  all = false
  projectAll = false
  readonly dialects = new Set<string>()
  readonly projectDialects = new Set<string>()
  readonly keys = new Set<string>()
  readonly projectKeys = new Set<string>()

  /** True when a key list turns this hook off. */
  offByKey(h: CanonicalHook): boolean {
    return (
      this.keys.has(h.trustKey) || (h.source.scope !== "user" && this.projectKeys.has(h.trustKey))
    )
  }

  /** True when any switch turns this hook off. */
  off(h: CanonicalHook): boolean {
    if (this.all || this.dialects.has(h.dialect) || this.offByKey(h)) return true
    if (h.source.scope === "user") return false
    return this.projectAll || this.projectDialects.has(h.dialect)
  }
}

/** The last outcome of one hook, for `/hooks`. */
export interface LastResult {
  /** `allow`, `deny`, `ask`, `none`, or `error: <text>`. */
  outcome: string
  /** Epoch ms. */
  at: number
}

/** Max hooks with a remembered last result. The oldest is dropped first. */
export const MAX_LAST_RESULTS = 256

/** Why a supported hook does not run, or `enabled`. */
export type EnabledState = "enabled" | "disabled" | "disabled-by-config" | "shadowed"

/** One `/hooks` row. */
export interface HookStatus {
  hook: CanonicalHook
  trust: TrustState
  enabled: EnabledState
  last?: LastResult
}

/** Max remembered "skipped hook" notices. */
const MAX_NOTICES = 1000

/** The config-driven hooks engine. */
export class HooksEngine {
  readonly config: HooksConfig
  readonly env: Env
  readonly cwd: string
  readonly projectRoot: string
  readonly agentHome: string
  /** `<agent home>/sessions`: the home of `<sid>.jsonl` transcripts. */
  readonly sessionsDir: string
  readonly adapters: HookDialectAdapter[]
  readonly trust: TrustStore
  readonly asyncQueue: AsyncHookQueue
  /** Every parsed hook, unsupported and disabled ones included (for /hooks). */
  all: CanonicalHook[] = []
  /**
   * Supported hooks that no config switch turns off, minus duplicates of a
   * trusted hook. Untrusted hooks stay here (they are skipped with a notice
   * at dispatch) but never take part in dedup.
   */
  active: CanonicalHook[] = []
  sources: LoadedSource[] = []
  /** Trust keys turned off by `disable` lists. */
  disabledKeys = new Set<string>()
  /** Hooks that a config switch turns off (disableAllHooks, dialect flag, disable list). */
  private configOff = new Set<CanonicalHook>()
  /** True when a user-scope native `disableAllHooks` is set. */
  allDisabled = false
  /** True when a trusted project or plugin native `disableAllHooks` is set. */
  projectDisabled = false
  readonly runs: RunRecord[] = []
  /** Last result per trust key (bounded, in memory only). */
  readonly lastResults = new Map<string, LastResult>()
  private readonly log: (msg: string) => void
  private readonly debug: (msg: string) => void
  private readonly plugins: PluginRef[]
  private signature = ""
  private readonly noticed = new Set<string>()

  /**
   * Create an engine and load its sources.
   *
   * @param opts - Engine options.
   */
  constructor(opts: EngineOptions) {
    this.env = opts.env ?? process.env
    this.cwd = opts.cwd
    this.config = opts.config ?? defaultHooksConfig()
    this.projectRoot = findProjectRoot(opts.cwd)
    this.agentHome = resolveAgentHome(this.env as NodeJS.ProcessEnv)
    this.sessionsDir = resolveSessionsDir(this.env as NodeJS.ProcessEnv)
    this.adapters = opts.adapters ?? selectAdapters(this.config)
    this.plugins = opts.plugins ?? []
    this.log = opts.log ?? (() => {})
    this.debug = opts.debug ?? (() => {})
    this.trust = new TrustStore(trustStatePath(this.agentHome), this.env.MA_TRUST_HOOKS === "1")
    this.asyncQueue = opts.asyncQueue ?? new AsyncHookQueue(this.config.maxAsync)
    this.load()
  }

  private discoverAll(): Array<{ adapter: HookDialectAdapter; source: SourceRef }> {
    const out: Array<{ adapter: HookDialectAdapter; source: SourceRef }> = []
    const home = this.env.HOME ?? ""
    for (const adapter of this.adapters) {
      let list: SourceRef[] = []
      try {
        list = adapter.discover({
          home,
          agentHome: this.agentHome,
          projectRoot: this.projectRoot,
          plugins: this.plugins,
        })
      } catch (e) {
        this.log(`[hooks] ${adapter.id}: discover failed: ${String(e)}`)
      }
      for (const source of list) out.push({ adapter, source })
    }
    return out
  }

  private sourceSignature(paths: string[]): string {
    return paths
      .map((p) => {
        try {
          const st = statSync(p)
          return `${p}:${st.mtimeMs}:${st.size}`
        } catch {
          return `${p}:-`
        }
      })
      .join("|")
  }

  /** Discover, parse, filter and dedup every source. */
  load(): void {
    const found = this.discoverAll()
    this.signature = this.sourceSignature(this.watched(found.map((f) => f.source.path)))
    const all: CanonicalHook[] = []
    const sources: LoadedSource[] = []
    const sw = new Switches()
    for (const { adapter, source } of found) {
      const exists = existsSync(source.path)
      const loaded: LoadedSource = { adapter: adapter.id, source, exists, warnings: [] }
      sources.push(loaded)
      if (!exists) continue
      let text: string
      try {
        text = readFileSync(source.path, "utf8")
      } catch (e) {
        loaded.warnings.push(`read failed: ${String(e)}`)
        continue
      }
      try {
        const r = adapter.parse(source, text)
        loaded.warnings.push(...r.warnings)
        for (const d of r.debug ?? []) this.debug(`[hooks] ${adapter.id}:${source.id}: ${d}`)
        all.push(...r.hooks)
        this.applySwitches(sw, adapter, source, r, loaded)
      } catch (e) {
        loaded.warnings.push(`parse threw: ${String(e)}`)
      }
    }
    for (const s of sources) {
      for (const w of s.warnings) this.log(`[hooks] ${s.adapter}:${s.source.id}: ${w}`)
    }
    this.all = all
    this.sources = sources
    this.allDisabled = sw.all
    this.projectDisabled = sw.projectAll
    const eligible = all.filter((h) => h.support === "ok" && h.channel !== "" && !sw.off(h))
    this.configOff = new Set(all.filter((h) => sw.off(h)))
    this.disabledKeys = new Set(all.filter((h) => sw.offByKey(h)).map((h) => h.trustKey))
    // Dedup only hooks that pass the trust and enabled filters, so an
    // untrusted copy never shadows a runnable hook (review B3 BLOCKER). The
    // trust state file is in the reload signature, so a trust change
    // recomputes this list.
    const runnable = eligible.filter((h) => this.verdict(h) === "trusted")
    const dropped = new Set(dedupHooks(runnable).dropped)
    this.active = eligible.filter((h) => !dropped.has(h))
  }

  /**
   * Record the disable switches of one source. A user source applies to
   * every hook. A project or plugin source applies only when the project is
   * trusted (or `MA_TRUST_HOOKS=1`), and then only to project and plugin
   * hooks: it can never turn off a user hook (review BLOCKER 1).
   */
  private applySwitches(
    sw: Switches,
    adapter: HookDialectAdapter,
    source: SourceRef,
    r: ParseResult,
    loaded: LoadedSource,
  ): void {
    const keys = adapter.authoritative ? (r.disable ?? []) : []
    if (!r.disableAll && keys.length === 0) return
    const user = source.scope === "user"
    if (!user && !this.trust.projectTrusted(this.projectRoot)) {
      loaded.warnings.push("disable switches ignored: the project is not trusted")
      return
    }
    if (r.disableAll) {
      if (adapter.authoritative) {
        if (user) sw.all = true
        else sw.projectAll = true
      } else (user ? sw.dialects : sw.projectDialects).add(adapter.id)
    }
    for (const k of keys) (user ? sw.keys : sw.projectKeys).add(k)
  }

  /** Source paths plus the trust state file: a `/hooks` change reloads too. */
  private watched(paths: string[]): string[] {
    return [...paths, this.trust.path]
  }

  /**
   * Reload when any source file or the trust state file changed (mtime,
   * size, or presence). A `/hooks trust` from any session or engine is seen
   * at the next dispatch.
   */
  reloadIfChanged(): boolean {
    const paths = this.watched(this.sources.map((s) => s.source.path))
    if (this.sourceSignature(paths) === this.signature) return false
    this.trust.invalidate()
    this.load()
    return true
  }

  /** Channels that have at least one runnable hook. */
  channels(): string[] {
    return [...new Set(this.active.map((h) => h.channel))]
  }

  /** Trust verdict for one hook in this project. */
  verdict(hook: CanonicalHook): TrustVerdict {
    return this.trust.verdict(this.projectRoot, hook)
  }

  /**
   * Runnable hooks that trust blocks (untrusted project or changed hash).
   * Disabled hooks are not listed. Reloads first when a source changed.
   */
  untrustedHooks(): CanonicalHook[] {
    this.reloadIfChanged()
    return this.active.filter((h) => {
      const v = this.verdict(h)
      return v === "untrusted-project" || v === "untrusted-hash"
    })
  }

  /** The hook with this trust key, after a reload check. */
  findHook(trustKey: string): CanonicalHook | undefined {
    this.reloadIfChanged()
    return this.all.find((h) => h.trustKey === trustKey)
  }

  /** Every hook from one source file (absolute, or relative to the project root). */
  hooksFromFile(file: string): CanonicalHook[] {
    this.reloadIfChanged()
    const abs = isAbsolute(file) ? resolve(file) : resolve(this.projectRoot, file)
    return this.all.filter((h) => resolve(h.source.path) === abs)
  }

  /** One `/hooks` row per parsed hook, in load order. */
  status(): HookStatus[] {
    this.reloadIfChanged()
    const active = new Set(this.active)
    return this.all.map((hook) => {
      let enabled: EnabledState = "enabled"
      if (!this.trust.stateEnabled(this.projectRoot, hook.trustKey)) enabled = "disabled"
      else if (hook.support === "ok" && !active.has(hook)) {
        enabled = this.offByConfig(hook) ? "disabled-by-config" : "shadowed"
      }
      const last = this.lastResults.get(hook.trustKey)
      return {
        hook,
        trust: this.trust.trustState(this.projectRoot, hook),
        enabled,
        ...(last ? { last } : {}),
      }
    })
  }

  private offByConfig(h: CanonicalHook): boolean {
    return this.configOff.has(h)
  }

  private adapterFor(hook: CanonicalHook): HookDialectAdapter | undefined {
    return this.adapters.find((a) => a.id === hook.dialect)
  }

  private invocation(payload: unknown, dc: DispatchContext): InvocationContext {
    const p = isObj(payload) ? payload : {}
    const agentMode = str(p.agentMode)
    const agentId = str(p.agentId)
    const leadSid = str(p.leadSid)
    const sid = str(p.sid) ?? dc.sid ?? ""
    return {
      sid,
      cwd: str(p.cwd) ?? dc.cwd ?? this.cwd,
      projectDir: this.projectRoot,
      // The session jsonl (core `plugin-api/src/utils/agent-paths.ts:53`).
      ...(sid ? { transcriptPath: join(this.sessionsDir, `${sid}.jsonl`) } : {}),
      ...(agentMode ? { agentMode } : {}),
      ...(agentId ? { agentId } : {}),
      ...(leadSid ? { leadSid } : {}),
    }
  }

  private noticeOnce(key: string, msg: string): void {
    if (this.noticed.has(key)) return
    this.noticed.add(key)
    if (this.noticed.size > MAX_NOTICES) {
      const oldest = this.noticed.values().next().value
      if (oldest !== undefined) this.noticed.delete(oldest)
    }
    this.log(msg)
  }

  /** Hooks that match and may run for this emit. */
  selectHooks(channel: string, payload: unknown, sid = ""): CanonicalHook[] {
    const out: CanonicalHook[] = []
    for (const h of this.active) {
      if (h.channel !== channel) continue
      let hit = false
      try {
        hit = h.matches({ channel, payload })
      } catch {
        hit = false
      }
      if (!hit) continue
      const v = this.verdict(h)
      if (v === "trusted") {
        out.push(h)
        continue
      }
      if (v !== "disabled") {
        this.noticeOnce(
          `${sid}\u0000${h.trustKey}`,
          `[hooks] skipped ${v} hook ${h.trustKey} (${h.source.path}); review it with /hooks`,
        )
      }
    }
    return out
  }

  /** Run one hook and decode its outcome. Never throws. */
  async runOne(
    hook: CanonicalHook,
    channel: string,
    payload: unknown,
    inv: InvocationContext,
    abort?: AbortSignal,
    budgetMs?: number,
  ): Promise<CanonicalResult> {
    const adapter = this.adapterFor(hook)
    if (!adapter) return { decision: "none", context: [], error: "no adapter" }
    let result: CanonicalResult
    let exitCode: number | null = null
    let durationMs = 0
    try {
      const { stdin, env, handler } = adapter.encodeInput(hook, channel, payload, inv)
      const run = await runHandler({
        handler: handler ?? hook.handler,
        stdin,
        env,
        cwd: this.projectRoot,
        timeoutMs: budgetMs ? Math.min(hook.timeoutMs, budgetMs) : hook.timeoutMs,
        baseEnv: this.env,
        ...(abort ? { abort } : {}),
      })
      exitCode = run.exitCode
      durationMs = run.durationMs
      result = adapter.decodeOutput(hook, channel, run, payload)
      if (run.error && !result.error) result = { ...result, error: run.error }
    } catch (e) {
      result = { decision: "none", context: [], error: String(e) }
    }
    if (result.error && hook.failClosed && result.decision !== "deny") {
      result = { ...result, decision: "deny", reason: `Hook failed (fail closed): ${result.error}` }
    }
    const outDir = join(this.agentHome, "hooks-output")
    const cap = this.config.outputCapChars
    result = {
      ...result,
      context: result.context.map((c) => capText(c, cap, outDir)),
      ...(result.reason ? { reason: capText(result.reason, cap, outDir) } : {}),
    }
    const rec: RunRecord = {
      dialect: hook.dialect,
      channel,
      trustKey: hook.trustKey,
      exitCode,
      durationMs,
      decision: result.decision,
      ...(result.error ? { error: result.error } : {}),
    }
    this.runs.push(rec)
    this.lastResults.delete(hook.trustKey)
    this.lastResults.set(hook.trustKey, {
      outcome: result.error ? `error: ${result.error}` : result.decision,
      at: Date.now(),
    })
    while (this.lastResults.size > MAX_LAST_RESULTS) {
      const oldest = this.lastResults.keys().next().value
      if (oldest === undefined) break
      this.lastResults.delete(oldest)
    }
    if (this.runs.length > 200) this.runs.splice(0, this.runs.length - 200)
    if (result.error) this.log(`[hooks] ${hook.trustKey}: ${result.error}`)
    if (result.debug) this.debug(`[hooks] ${hook.trustKey}: ${result.debug}`)
    return result
  }

  /** Run the matching hooks for one emit and merge their results. */
  async evaluate(
    channel: string,
    payload: unknown,
    dc: DispatchContext = {},
  ): Promise<MergedResult & { ran: number }> {
    this.reloadIfChanged()
    const inv = this.invocation(payload, dc)
    const hooks = this.selectHooks(channel, payload, inv.sid)
    const budget = channelInfo(channel).budgetMs
    for (const h of hooks.filter((x) => x.async)) {
      this.asyncQueue.push(async (signal) => {
        const r = await this.runOne(h, channel, payload, inv, signal)
        if (r.position !== "before") return r.context
        return r.context.map((text): HookContextEntry => ({ text, position: "before" }))
      }, inv.sid)
    }
    const sync = hooks.filter((h) => !h.async)
    const results = await Promise.all(
      sync.map((h) => this.runOne(h, channel, payload, inv, dc.abort, budget)),
    )
    return { ...mergeResults(results), ran: sync.length }
  }

  /**
   * Apply the winning payload rewrite through the per-channel allow-list
   * ({@link rewritableKeys}). Keys outside the list (sid, agentId, cwd, tool,
   * toolUseId, ...) are ignored and logged once per channel and key set, so a
   * hook cannot retarget a call or change session identity (review B3 MAJOR 2).
   */
  private rewrite(channel: string, payload: unknown, patch: unknown, sid: string): unknown {
    const allowed = rewritableKeys(channel)
    if (!isObj(patch) || !isObj(payload)) {
      this.noticeOnce(
        `${sid}\u0000rewrite\u0000${channel}\u0000non-object`,
        `[hooks] ${channel}: ignored a non-object payload rewrite`,
      )
      return payload
    }
    const keys = Object.keys(patch)
    const extra = keys.filter((k) => !allowed.includes(k))
    if (extra.length > 0) {
      const only = allowed.length > 0 ? `only ${allowed.join(", ")} may change` : "context only"
      this.noticeOnce(
        `${sid}\u0000rewrite\u0000${channel}\u0000${extra.join(",")}`,
        `[hooks] ${channel}: ignored payload keys ${extra.join(", ")} (${only})`,
      )
    }
    const kept = keys.filter((k) => allowed.includes(k))
    if (kept.length === 0) return payload
    const next: Record<string, unknown> = { ...payload }
    for (const k of kept) next[k] = patch[k]
    return next
  }

  /** Turn one HookBus emit into a chain listener result. */
  async dispatch(
    channel: string,
    payload: unknown,
    dc: DispatchContext = {},
  ): Promise<EngineChainResult> {
    if (!this.config.enabled) return undefined
    const info = channelInfo(channel)
    const sid = this.invocation(payload, dc).sid
    const queued = info.injectsQueued ? this.asyncQueue.drain(sid) : []
    const m = await this.evaluate(channel, payload, dc)
    const qBefore: string[] = []
    const qAfter: string[] = []
    for (const e of queued) {
      if (typeof e === "string") qAfter.push(e)
      else if (e.position === "before") qBefore.push(e.text)
      else qAfter.push(e.text)
    }
    const context = contextEntries(
      channel,
      [...qBefore, ...m.contextBefore],
      [...qAfter, ...m.context],
    )
    const ctxPart = context.length > 0 ? { additionalContext: context } : {}
    const next = m.payload === undefined ? payload : this.rewrite(channel, payload, m.payload, sid)
    if (info.blocking) {
      // `ask` has no host prompt through the plugin API: deny (SPEC.md "Ask").
      if (m.decision === "deny" || m.decision === "ask") {
        const reason = m.reasons.join("\n") || "Blocked by hook."
        return { halt: true, reason, payload: next, ...ctxPart }
      }
      // continue:false stops the turn. On turn.willStop it means "let it stop".
      if (m.stopTurn && channel !== "turn.willStop") {
        return {
          halt: true,
          reason: m.stopTurn.reason ?? "Stopped by hook.",
          payload: next,
          ...ctxPart,
        }
      }
    }
    for (const msg of m.userMessages) this.log(`[hooks] ${msg}`)
    if (next === payload && context.length === 0) return undefined
    return { payload: next, ...ctxPart }
  }
}
