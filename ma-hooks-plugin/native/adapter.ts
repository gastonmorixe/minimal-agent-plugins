/**
 * Native dialect: minimal-agent's own hook config and wire protocol
 * (SPEC.md "Native protocol"). Always first in discovery and authoritative:
 * its `disableAllHooks` and `disable` apply to every dialect.
 *
 * Sources, in order: `<agent home>/hooks.json`,
 * `<project>/.minimal-agent/hooks.json`, `<project>/.minimal-agent/hooks.local.json`,
 * then `hooks/hooks.json` of each enabled minimal-agent plugin.
 *
 * Depends on the engine's canonical types and channel catalog only.
 *
 * @module native/adapter
 */

import { join } from "node:path"

import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

import { channelInfo, isHookChannel } from "../engine/channels.ts"
import { hookContentHash, TrustKeyAllocator } from "../engine/hash.ts"
import { withoutUserCopies } from "../engine/project.ts"
import {
  type CanonicalHook,
  type CanonicalResult,
  type DiscoverEnv,
  type HookContextPosition,
  type HookDialectAdapter,
  type HookHandlerSpec,
  type HookSupport,
  type InvocationContext,
  isContextPosition,
  type MatchContext,
  type ParseResult,
  type RunOutcome,
  type SourceRef,
} from "../engine/types.ts"

/** Default per-hook timeout: 600 s (SPEC.md "Engine execution"). */
export const DEFAULT_TIMEOUT_MS = 600_000

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function strMap(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x
  return out
}

/** The payload field a native matcher tests, per channel. */
export function nativeMatchField(channel: string, payload: unknown): string | undefined {
  if (!isObj(payload)) return undefined
  const pick = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : undefined)
  if (channel.startsWith("tool.")) return pick("tool")
  if (channel === "session.willStart") return pick("source")
  if (channel.startsWith("compact.")) return pick("reason")
  if (channel.startsWith("subagent.")) return pick("type")
  if (channel === "notification.emit") return pick("type") ?? pick("source")
  return undefined
}

/** True when the channel has a match field (else the matcher is ignored). */
function hasMatchField(channel: string): boolean {
  return (
    channel.startsWith("tool.") ||
    channel.startsWith("compact.") ||
    channel.startsWith("subagent.") ||
    channel === "session.willStart" ||
    channel === "notification.emit"
  )
}

/**
 * Build a native matcher: an unanchored, case-sensitive regex. `*`, empty or
 * omitted matches all. A bad regex matches nothing.
 */
export function nativeMatcher(
  channel: string,
  matcher: string | undefined,
): { fn: (ctx: MatchContext) => boolean; error?: string } {
  if (matcher === undefined || matcher === "" || matcher === "*" || !hasMatchField(channel)) {
    return { fn: () => true }
  }
  let re: RegExp
  try {
    re = new RegExp(matcher)
  } catch (e) {
    return { fn: () => false, error: e instanceof Error ? e.message : String(e) }
  }
  return {
    fn: (ctx) => {
      const v = nativeMatchField(ctx.channel, ctx.payload)
      return v !== undefined && re.test(v)
    },
  }
}

function parseHandler(raw: Obj): { handler: HookHandlerSpec; support: HookSupport } {
  const type = raw.type ?? "command"
  if (type === "command" && typeof raw.command === "string") {
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === "string")
      : undefined
    const env = strMap(raw.env)
    return {
      handler: {
        type: "command",
        command: raw.command,
        ...(args ? { args } : {}),
        ...(raw.shell === "bash" || raw.shell === "sh" ? { shell: raw.shell } : {}),
        ...(env ? { env } : {}),
      },
      support: "ok",
    }
  }
  if (type === "http" && typeof raw.url === "string") {
    const headers = strMap(raw.headers)
    const allowed = Array.isArray(raw.allowedEnvVars)
      ? raw.allowedEnvVars.filter((a): a is string => typeof a === "string")
      : undefined
    return {
      handler: {
        type: "http",
        url: raw.url,
        ...(headers ? { headers } : {}),
        ...(allowed ? { allowedEnvVars: allowed } : {}),
      },
      support: "ok",
    }
  }
  return {
    handler: { type: "command", command: typeof raw.command === "string" ? raw.command : "" },
    support: "unsupported-type",
  }
}

/** Parse native config text into canonical hooks. Never throws. */
export function parseNative(source: SourceRef, text: string, dialect = "native"): ParseResult {
  const warnings: string[] = []
  const hooks: CanonicalHook[] = []
  const keys = new TrustKeyAllocator()
  let doc: unknown
  try {
    doc = parseJsonc(text)
  } catch (e) {
    return { hooks, warnings: [`${source.path}: parse error: ${String(e)}`] }
  }
  if (!isObj(doc)) return { hooks, warnings: [`${source.path}: top level is not an object`] }
  const out: ParseResult = { hooks, warnings }
  if (doc.disableAllHooks === true) out.disableAll = true
  if (Array.isArray(doc.disable)) {
    out.disable = doc.disable.filter((s): s is string => typeof s === "string")
  }
  if (doc.hooks === undefined) return out
  if (!isObj(doc.hooks)) {
    warnings.push(`${source.path}: "hooks" is not an object`)
    return out
  }
  for (const [channel, groups] of Object.entries(doc.hooks)) {
    if (!Array.isArray(groups)) {
      warnings.push(`${source.path}: hooks.${channel} is not an array`)
      continue
    }
    const known = isHookChannel(channel)
    groups.forEach((group, gi) => {
      if (!isObj(group) || !Array.isArray(group.hooks)) {
        warnings.push(`${source.path}: hooks.${channel}[${gi}] has no hooks array`)
        return
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined
      const m = nativeMatcher(channel, matcher)
      if (m.error)
        warnings.push(`${source.path}: bad matcher ${JSON.stringify(matcher)}: ${m.error}`)
      group.hooks.forEach((rawHook, hi) => {
        if (!isObj(rawHook)) {
          warnings.push(`${source.path}: hooks.${channel}[${gi}].hooks[${hi}] is not an object`)
          return
        }
        const { handler, support } = parseHandler(rawHook)
        const timeoutMs =
          typeof rawHook.timeout === "number" && rawHook.timeout > 0
            ? Math.round(rawHook.timeout * 1000)
            : DEFAULT_TIMEOUT_MS
        const isAsync = rawHook.async === true
        const failClosed = rawHook.failClosed === true
        let position: HookContextPosition = "after"
        if (isContextPosition(rawHook.position)) position = rawHook.position
        else if (rawHook.position !== undefined) {
          warnings.push(
            `${source.path}: hooks.${channel}[${gi}].hooks[${hi}]: bad position ${JSON.stringify(rawHook.position)} (use "before" or "after"), using "after"`,
          )
        }
        const contentHash = hookContentHash({
          dialect,
          channel: known ? channel : "",
          event: channel,
          ...(matcher !== undefined ? { matcher } : {}),
          handler,
          timeoutMs,
          async: isAsync,
          failClosed,
          position,
        })
        hooks.push({
          trustKey: keys.next(`${dialect}:${source.id}:${channel}`, {
            ...(matcher !== undefined ? { matcher } : {}),
            handler,
          }),
          dialect,
          source,
          channel: known ? channel : "",
          dialectEvent: channel,
          ...(matcher !== undefined ? { matcher } : {}),
          matches: m.fn,
          handler,
          timeoutMs,
          async: isAsync,
          failClosed,
          ...(typeof rawHook.statusMessage === "string"
            ? { statusMessage: rawHook.statusMessage }
            : {}),
          position,
          support: known ? support : "unsupported-event",
          contentHash,
        })
      })
    })
  }
  return out
}

/** Native stdin envelope and env for one call. */
export function encodeNative(
  hook: CanonicalHook,
  channel: string,
  payload: unknown,
  ctx: InvocationContext,
): { stdin: string; env: Record<string, string> } {
  const stdin = JSON.stringify({
    channel,
    payload,
    sid: ctx.sid,
    cwd: ctx.cwd,
    projectDir: ctx.projectDir,
    mode: ctx.agentMode ?? "default",
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.leadSid ? { leadSid: ctx.leadSid } : {}),
  })
  const env: Record<string, string> = {
    MA_PROJECT_DIR: ctx.projectDir,
    MA_SESSION_ID: ctx.sid,
    MA_CHANNEL: channel,
  }
  if (hook.source.pluginRoot) env.MA_PLUGIN_ROOT = hook.source.pluginRoot
  if (hook.source.pluginData) env.MA_PLUGIN_DATA = hook.source.pluginData
  return { stdin, env }
}

function strList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v] : []
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
}

/** The result `position` field: set only for `before` (missing means `after`). */
function posPart(p: HookContextPosition): { position?: HookContextPosition } {
  return p === "before" ? { position: "before" } : {}
}

/** Max characters of a hook output value in a debug note. */
const DEBUG_VALUE_MAX = 80

/** JSON of an arbitrary hook output value, capped for the debug log. */
export function debugValue(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > DEBUG_VALUE_MAX ? `${s.slice(0, DEBUG_VALUE_MAX)}...` : s
}

function decodeJson(obj: Obj, configPosition: HookContextPosition): CanonicalResult {
  const d = obj.decision
  const decision: CanonicalResult["decision"] =
    d === "allow" || d === "deny" || d === "ask" || d === "none" ? d : "none"
  // A valid output `position` beats the config. A bad one is ignored (debug log).
  const p = obj.position
  const position = isContextPosition(p) ? p : configPosition
  const r: CanonicalResult = { decision, context: strList(obj.context), ...posPart(position) }
  if (p !== undefined && !isContextPosition(p)) {
    r.debug = `ignored output position ${debugValue(p)}, using "${configPosition}"`
  }
  if (typeof obj.reason === "string") r.reason = obj.reason
  if (obj.payload !== undefined) r.payload = obj.payload
  if (obj.continue === false) {
    r.stopTurn = typeof obj.reason === "string" ? { reason: obj.reason } : {}
  } else if (isObj(obj.stopTurn)) {
    r.stopTurn = typeof obj.stopTurn.reason === "string" ? { reason: obj.stopTurn.reason } : {}
  }
  const msg = obj.message ?? obj.userMessage
  if (typeof msg === "string") r.userMessage = msg
  return r
}

/** Map a native run outcome to a canonical result. Never throws. */
export function decodeNative(
  hook: CanonicalHook,
  channel: string,
  run: RunOutcome,
): CanonicalResult {
  const position = hook.position ?? "after"
  const pos = posPart(position)
  if (run.timedOut || run.exitCode === null) {
    return { decision: "none", context: [], error: run.error ?? "hook did not exit" }
  }
  const info = channelInfo(channel)
  if (run.exitCode === 2) {
    const text = run.stderr.trim()
    if (!info.blocking) return { decision: "none", context: text ? [text] : [], ...pos }
    return { decision: "deny", reason: text || "Blocked by hook.", context: [] }
  }
  if (run.exitCode !== 0) {
    const tail = run.stderr.trim().slice(0, 500)
    return {
      decision: "none",
      context: [],
      error: `exit ${run.exitCode}${tail ? `: ${tail}` : ""}`,
    }
  }
  const out = run.stdout.trim()
  if (out === "") return { decision: "none", context: [] }
  if (out.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(out)
      if (isObj(parsed)) return decodeJson(parsed, position)
    } catch {
      // not JSON: plain text below
    }
  }
  return { decision: "none", context: info.plainTextContext ? [out] : [], ...pos }
}

/** Native source files for this home and project. */
export function discoverNative(env: DiscoverEnv): SourceRef[] {
  const dir = join(env.projectRoot, ".minimal-agent")
  const out: SourceRef[] = [
    { id: "user", path: join(env.agentHome, "hooks.json"), scope: "user", precedence: 0 },
    { id: "project", path: join(dir, "hooks.json"), scope: "project", precedence: 1 },
    { id: "project-local", path: join(dir, "hooks.local.json"), scope: "project", precedence: 2 },
  ]
  env.plugins.forEach((p, i) => {
    out.push({
      id: `plugin:${p.name}`,
      path: join(p.root, "hooks", "hooks.json"),
      scope: "plugin",
      precedence: 3 + i,
      pluginRoot: p.root,
      ...(p.dataDir ? { pluginData: p.dataDir } : {}),
    })
  })
  return withoutUserCopies(out)
}

/** The native adapter instance. */
export const nativeAdapter: HookDialectAdapter = {
  id: "native",
  authoritative: true,
  discover: discoverNative,
  parse: (source, text) => parseNative(source, text),
  encodeInput: encodeNative,
  decodeOutput: (hook, channel, run) => decodeNative(hook, channel, run),
}
