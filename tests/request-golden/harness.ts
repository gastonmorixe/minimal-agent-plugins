/**
 * Request golden harness (S0.1). It loads the real first-party plugins, runs
 * an AgentCore with a stub sendFn, and records every LLM request as canonical
 * JSON. See README.md.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { NO_TOOLS_EXECUTOR } from "@minimal-agent/core"
import { BlobStore } from "@minimal-agent/core/host-kit/blob-store"
import { ModeManager } from "@minimal-agent/core/host-kit/modes"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"

/** The one tool the noExecutor path lists. A name and an input schema only. */
const NO_EXECUTOR_TOOL = {
  name: "Stub",
  description: "Stub tool for the no-executor scenario.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
}

export const GOLDEN_DIR = resolve(import.meta.dir, "goldens")
const TMP_BASE = resolve(import.meta.dir, ".tmp")
const PLUGINS_ROOT = resolve(import.meta.dir, "../..")
const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5)
/** Platform the goldens are recorded against, whatever the host OS is. */
const GOLDEN_PLATFORM = "macos" as const

/** A scripted model reply for one round. */
export interface ScriptedReply {
  /** A signed thinking block before the text and tools (signature `sig-<round>`). */
  thinking?: string
  text?: string
  tools?: Array<{ name: string; input: Record<string, unknown> }>
  stopReason?: string
  /** Mirrors StreamedResponse.stopDetails (for example stream_closed_without_terminal). */
  stopDetails?: Record<string, unknown>
}

/** Everything a scenario can use. */
export interface ScenarioCtx {
  /** Temp working directory (the process cwd during the run). */
  cwd: string
  /** Drive one turn. Returns after the turn ends. */
  turn: (text: string, opts?: { signal?: AbortSignal }) => Promise<void>
  /** The wired core. */
  core: Awaited<ReturnType<typeof buildTestCore>>
  /** The mode manager (always present). */
  modes: ModeManager
  /** Scenario root (parent of cwd, home, blobs). Removed after the run. */
  root: string
  /** Build one more core on the same loader, modes and stub model. */
  newCore: (extra?: CoreExtra) => Promise<ScenarioCtx["core"]>
  /** Drive one turn on a given core. */
  turnOn: (
    core: ScenarioCtx["core"],
    text: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<void>
  /**
   * Append one request that did not go through the scripted send (e.g. the
   * compaction summary request, sent by the provider adapter). It is stored
   * as a JSON copy, in call order, and takes the next request index.
   */
  record: (request: Record<string, unknown>) => void
}

/** Extra deps for buildTestCore (store, model, providerId, networkClient ...). */
export type CoreExtra = Record<string, unknown>

/** One scenario. */
export interface Scenario {
  name: string
  /** Scripted replies per round. After the script ends the model says "done". */
  script: ScriptedReply[]
  /** Needs the rg binary on PATH. The scenario fails with RgMissingError if absent. */
  needsRg?: true
  /** Give the core a blob store. */
  blobStore?: boolean
  /** Keep only these request indexes (negative counts from the end). Default: all. */
  keep?: number[]
  /** Extra deps for the first core. Runs after setup, before the core is built. */
  coreDeps?: (paths: { root: string; cwd: string }) => CoreExtra
  /**
   * Build a plain AgentCore with NO_TOOLS_EXECUTOR and one listed stub tool
   * instead of buildTestCore. The system block is core's own default text, by design.
   */
  noExecutor?: true
  /** Optional fixtures, runs before the core is built. */
  setup?: (cwd: string) => void
  /** Extra plugin dirs, appended after the plugins root. Default: none. */
  pluginRoots?: (paths: { root: string; cwd: string }) => string[]
  /** The driver. */
  run: (ctx: ScenarioCtx) => Promise<void>
}

/** Embedded plugin roots for a scenario: the plugins root plus any extras. */
export function resolveEmbeddedRoots(
  scenario: Pick<Scenario, "pluginRoots">,
  paths: { root: string; cwd: string },
): string[] {
  return [PLUGINS_ROOT, ...(scenario.pluginRoots?.(paths) ?? [])]
}

const volatileEnvKeys = (): string[] =>
  Object.keys(process.env).filter((k) => k.startsWith("MINIMAL_AGENT_"))

/** Env-info keys have volatile values. Keep the key, drop the value. */
export function normalizeText(text: string, roots: string[]): string {
  let out = text
  for (const root of roots) out = out.split(root).join("<ROOT>")
  out = out.split(PLUGINS_ROOT).join("<PLUGINS>")
  // The env-info ini block lists host keys that differ per machine and shell.
  // Keep every key and the line order. Mask only the value.
  // The block has no fence. It is the run of key=value lines after the note.
  out = out.replace(
    /(Do not invent sibling absolute project roots\.\n\n)((?:[a-z_]+=[^\n]*(?:\n|$))+)/g,
    (_m, head: string, body: string) => head + body.replace(/^([a-z_]+=)[^\n]*$/gm, "$1<V>"),
  )
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
  // Grep returns "Grep error: <rg stderr, trimmed>" as the whole result. rg text differs per version.
  out = out.replace(/(Grep error: )[\s\S]*$/, "$1<RG_STDERR>")
  out = out.replace(/"durationMs":\d+/g, '"durationMs":0')
  return out
}

function normalizeDeep(v: unknown, roots: string[]): unknown {
  if (typeof v === "string") return normalizeText(v, roots)
  if (Array.isArray(v)) return v.map((x) => normalizeDeep(x, roots))
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalizeDeep(x, roots)]),
    )
  }
  return v
}

/** Sorted keys, 2-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .filter((k) => o[k] !== undefined)
          .map((k) => [k, sort(o[k])]),
      )
    }
    return v
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`
}

const CAPTURED_FIELDS = ["tools", "system", "messages", "maxTokens"] as const
const OUTPUT_CONFIG_FIELDS = [
  "model",
  "effort",
  "outputConfig",
  "outputSchema",
  "outputStrict",
  "strict",
  "temperature",
  "speed",
  "serviceTier",
  "thinking",
] as const

/**
 * Internal tool_result keys. The encoders never send them on the wire, but the
 * capture copies the canonical messages before the encoder runs. Drop them so
 * the goldens record only wire-relevant data (leader decision L1).
 */
const TOOL_RESULT_INTERNAL_KEYS = ["outcome", "sideband"] as const

/**
 * Internal text block keys: the `sideband` block mark (design step 12c: core
 * marks the harness text blocks it inserts). No encoder sends it, so the
 * goldens do not record it.
 */
const TEXT_INTERNAL_KEYS = ["sideband"] as const

function stripToolResultInternal(block: unknown): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return
  const b = block as Record<string, unknown>
  const keys =
    b.type === "tool_result"
      ? TOOL_RESULT_INTERNAL_KEYS
      : b.type === "text"
        ? TEXT_INTERNAL_KEYS
        : []
  for (const k of keys) delete b[k]
}

/**
 * Remove the internal keys: `outcome` and `sideband` from tool_result blocks,
 * `sideband` from text blocks. Other keys and other block types stay.
 */
function stripInternalFromMessages(messages: unknown): void {
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    stripToolResultInternal(msg)
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      const content = (msg as Record<string, unknown>).content
      if (Array.isArray(content)) for (const block of content) stripToolResultInternal(block)
    }
  }
}

/** Copy the captured fields of one send call (exported for the harness test). */
export function pick(opts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of [...CAPTURED_FIELDS, ...OUTPUT_CONFIG_FIELDS]) {
    if (opts[k] !== undefined) out[k] = opts[k]
  }
  const copy = JSON.parse(JSON.stringify(out)) as Record<string, unknown>
  stripInternalFromMessages(copy.messages)
  return copy
}

function scriptedSend(
  scenario: Scenario,
  captured: Array<Record<string, unknown>>,
): (opts: Record<string, unknown>) => AsyncGenerator<string, unknown, undefined> {
  let round = 0
  return async function* (opts) {
    captured.push(pick(opts))
    const reply = scenario.script[round]
    round++
    const text = reply ? (reply.text ?? "") : "done"
    const blocks: Array<Record<string, unknown>> = []
    if (reply?.thinking) {
      blocks.push({ type: "thinking", thinking: reply.thinking, signature: `sig-${round}` })
    }
    if (text) blocks.push({ type: "text", text })
    for (const [i, t] of (reply?.tools ?? []).entries()) {
      blocks.push({ type: "tool_use", id: `call-${round}-${i}`, name: t.name, input: t.input })
    }
    const stopReason = reply?.stopReason ?? (reply?.tools?.length ? "tool_use" : "end_turn")
    if (text) yield text
    return {
      blocks,
      text,
      stopReason,
      ...(reply?.stopDetails ? { stopDetails: reply.stopDetails } : {}),
      usage: { input_tokens: 10, output_tokens: 3 },
    }
  }
}

/** Typed failure: a scenario needs rg but rg is not on PATH. */
export class RgMissingError extends Error {
  readonly kind = "RgMissingError"
  readonly scenario: string
  constructor(scenario: string) {
    super(`scenario "${scenario}" needs rg (ripgrep) on PATH, but rg was not found`)
    this.name = "RgMissingError"
    this.scenario = scenario
  }
}

/** Throw RgMissingError when the scenario sets needsRg and rg is missing. */
export function assertRgAvailable(
  scenario: Pick<Scenario, "name" | "needsRg">,
  which: (cmd: string) => string | null = (c) => Bun.which(c),
): void {
  if (scenario.needsRg && !which("rg")) throw new RgMissingError(scenario.name)
}

/** Test-only observers of one run. The golden output does not change. */
export interface RunHooks {
  /** Called with the loader before the first core is built. */
  onLoader?: (loader: PluginLoader) => void
  /** Called after the run with every raw captured request (before keep and normalize). */
  onRequests?: (
    requests: ReadonlyArray<Record<string, unknown>>,
    paths: { root: string; cwd: string; home: string },
  ) => void
}

/** Run one scenario and return its canonical golden text. */
export async function runScenario(scenario: Scenario, hooks: RunHooks = {}): Promise<string> {
  assertRgAvailable(scenario)
  mkdirSync(TMP_BASE, { recursive: true })
  const root = realpathSync(mkdtempSync(join(TMP_BASE, `${scenario.name}-`)))
  const cwd = join(root, "cwd")
  const home = join(root, "home")
  mkdirSync(cwd)
  mkdirSync(home)
  const prevCwd = process.cwd()
  const prevEnv = { ...process.env }
  for (const k of volatileEnvKeys()) delete process.env[k]
  process.env.HOME = home
  process.env.MINIMAL_AGENT_HOME = home
  // ma-fetch hides Fetch when its render engine is not installed. The goldens
  // pin the normal, provisioned toolset, so give the managed bin dir a stub
  // `obscura` (never executed: no scenario calls Fetch).
  const binDir = join(home, "bin")
  mkdirSync(binDir)
  writeFileSync(join(binDir, "obscura"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  process.env.MINIMAL_AGENT_BIN_DIR = binDir
  // gather.sh pipes through sort, which follows the locale. en_US puts term_cols
  // before term=, C puts term= first. The goldens use C order. Pin it. The
  // finally block restores the old values.
  process.env.LC_ALL = "C"
  // Bun's homedir() ignores HOME, so the ma-skills plugin would scan the real
  // home. Turn off every skill root through its config file in the temp home.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: {
        "ma-skills": {
          roots: { project: false, projectClaudeCode: false, homeShared: false, userAgent: false },
          extraRoots: [],
        },
      },
    }),
  )
  try {
    scenario.setup?.(cwd)
    process.chdir(cwd)
    const loader = await PluginLoader.load({
      roots: { embedded: resolveEmbeddedRoots(scenario, { root, cwd }) },
      logger: () => {},
      // Pin platform gating so goldens are host-independent. They are recorded
      // as macOS (the CI runner), which loads macOS-only plugins such as
      // ma-chrome-cdp and ma-computer-use. Without this a Linux host drops
      // their tools and prompt fragments and every golden differs.
      effectivePlatform: GOLDEN_PLATFORM,
    })
    hooks.onLoader?.(loader)
    const modes = new ModeManager(loader.getModes(), null, "dark", () => new Date(FIXED_NOW_MS))
    const captured: Array<Record<string, unknown>> = []
    const send = scriptedSend(scenario, captured)
    const blobStore = scenario.blobStore
      ? new BlobStore({ sid: "golden-sid", dir: join(root, "blobs") })
      : null
    const newCore = (extra: CoreExtra = {}) =>
      scenario.noExecutor
        ? Promise.resolve(
            new AgentCore({
              auth: { type: "api-key", token: "test-token" },
              model: "test-model",
              systemPrompt: "You are a test agent.",
              maxTokens: 8192,
              toolRegistry: { list: () => [NO_EXECUTOR_TOOL] },
              toolExecutor: NO_TOOLS_EXECUTOR,
              // The executor text is the tool_result.no_executor kind (P3.7).
              syntheticTextProviders: loader.syntheticTextProviders(),
              sendFn: send as never,
              retry: { clock: { now: () => FIXED_NOW_MS, sleep: async () => {} } },
            } as never),
          )
        : buildTestCore({
            auth: { type: "api-key", token: "test-token" },
            sendFn: send as never,
            loader,
            modeManager: modes,
            blobStore,
            retry: { clock: { now: () => FIXED_NOW_MS, sleep: async () => {} } },
            ...extra,
          } as never)
    const core = await newCore(scenario.coreDeps?.({ root, cwd }))
    const turnOn: ScenarioCtx["turnOn"] = async (c, text, opts) => {
      const gen = c.run(text, opts?.signal ? { signal: opts.signal } : undefined)
      while (!(await gen.next()).done) {
        // drain
      }
    }
    const turn: ScenarioCtx["turn"] = (text, opts) => turnOn(core, text, opts)
    const record: ScenarioCtx["record"] = (request) => {
      captured.push(JSON.parse(JSON.stringify(request)))
    }
    await scenario.run({ cwd, turn, core, modes, root, newCore, turnOn, record })
    hooks.onRequests?.(captured, { root, cwd, home })
    const keep = scenario.keep
    const picked = keep
      ? keep.map((i) => captured.at(i)).filter((r): r is Record<string, unknown> => !!r)
      : captured
    const roots = [...new Set([root, resolve(root)])]
    return canonicalJson(normalizeDeep({ scenario: scenario.name, requests: picked }, roots))
  } finally {
    process.chdir(prevCwd)
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k]
    Object.assign(process.env, prevEnv)
    rmSync(root, { recursive: true, force: true })
  }
}

/** Path of the golden file for a scenario. */
export function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.json`)
}
