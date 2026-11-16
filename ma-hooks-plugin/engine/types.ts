/**
 * Canonical hook model owned by the engine.
 *
 * Every dialect (native, claude, a future codex) turns its own config and
 * wire protocol into these types. Adapters import this file only: never the
 * engine runtime and never another adapter. Shapes follow
 * `research/2026-11-15-hooks-plugin-adapters/SPEC.md` ("Canonical model" and
 * "Adapter interface").
 *
 * @module engine/types
 */

/** Dialect id. `native` is minimal-agent's own format and is pinned first. */
export type HookDialectId = "native" | "claude" | (string & {})

/** Where hook context goes relative to the user's text. Default `after`. */
export type HookContextPosition = "before" | "after"

/**
 * One additionalContext entry for the HookBus. A plain string means `after`.
 * Mirror of `@minimal-agent/core` plugin-api/sdk HookContextEntry. Switch to the
 * import when core lands.
 */
export type HookContextEntry = string | { text: string; position?: HookContextPosition }

/** True when `v` is a valid {@link HookContextPosition}. */
export function isContextPosition(v: unknown): v is HookContextPosition {
  return v === "before" || v === "after"
}

/** Where a source file lives. `user` is trusted implicitly. */
export type HookScope = "user" | "project" | "plugin"

/** One config file an adapter reads (resolved for this home and project). */
export interface SourceRef {
  /** Stable id inside the dialect, e.g. `user`, `project`, `project-local`, `plugin:<name>`. */
  id: string
  /** Absolute path of the file. */
  path: string
  scope: HookScope
  /** Lower runs and wins first. The engine sets the final order. */
  precedence: number
  /** Plugin root for plugin sources (`MA_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`). */
  pluginRoot?: string
  /** Plugin data dir for plugin sources. */
  pluginData?: string
}

/** A plugin that may ship a `hooks/hooks.json`. */
export interface PluginRef {
  name: string
  root: string
  dataDir?: string
}

/** Paths an adapter needs to discover its sources. */
export interface DiscoverEnv {
  /** The user home (`$HOME`). */
  home: string
  /** The minimal-agent home (`MINIMAL_AGENT_HOME` or `$HOME/.minimal-agent`). */
  agentHome: string
  /** Git root of the cwd, or the cwd. */
  projectRoot: string
  plugins: PluginRef[]
}

/** Values a matcher closure tests. */
export interface MatchContext {
  channel: string
  payload: unknown
}

/** A command handler: shell form (`command` only) or exec form (`command` + `args`). */
export interface CommandHandler {
  type: "command"
  command: string
  args?: string[]
  shell?: "sh" | "bash"
  env?: Record<string, string>
}

/** An HTTP handler: POSTs the stdin JSON to `url`. */
export interface HttpHandler {
  type: "http"
  url: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
}

/** The runnable part of a hook. */
export type HookHandlerSpec = CommandHandler | HttpHandler

/** Support state of a parsed hook. Only `ok` hooks run. */
export type HookSupport = "ok" | "unsupported-event" | "unsupported-type"

/** One hook in the canonical table. */
export interface CanonicalHook {
  /**
   * `<dialect>:<sourceId>:<event>:<8 hex of the identity>`, plus `-<n>` for a
   * repeat identity in one file (`engine/hash.ts` TrustKeyAllocator). Not
   * positional: inserting a hook keeps the other keys.
   */
  trustKey: string
  dialect: HookDialectId
  source: SourceRef
  /** minimal-agent channel, e.g. `tool.willInvoke`. Empty for unsupported events. */
  channel: string
  /** The dialect's own event name, for display. */
  dialectEvent: string
  /** Raw matcher text, used for dedup and display. */
  matcher?: string
  /** An extra dialect filter (the Claude `if` rule), for display. */
  filter?: string
  /**
   * Extra dedup identity for filters outside `matcher` (an event split on a
   * shared channel, a Claude `if`). Hooks with different scopes never dedup.
   */
  dedupScope?: string
  /** Adapter-provided matcher closure. */
  matches(ctx: MatchContext): boolean
  handler: HookHandlerSpec
  timeoutMs: number
  async: boolean
  failClosed: boolean
  statusMessage?: string
  /**
   * Where this hook's context goes on `turn.willStart` and `session.willStart`.
   * Missing means `after`. Only native hooks set `before`.
   */
  position?: HookContextPosition
  support: HookSupport
  /** Hash of the normalized dialect, channel, matcher and handler. */
  contentHash: string
}

/** Decoded result of one hook run. */
export interface CanonicalResult {
  decision: "allow" | "deny" | "ask" | "none"
  reason?: string
  /** Rewritten channel payload (shallow-merged onto the current one). */
  payload?: unknown
  /** additionalContext. */
  context: string[]
  /**
   * Position of every entry in `context` (one hook run has one position).
   * Missing means `after`.
   */
  position?: HookContextPosition
  /** `continue: false`. */
  stopTurn?: { reason?: string }
  /** A message for the user (not the model). */
  userMessage?: string
  /** Set when the run failed (timeout, spawn error, bad exit). Diagnostics only. */
  error?: string
  /** A note for the debug log (not an error), e.g. an ignored output field. */
  debug?: string
}

/** Values the engine knows about one invocation. */
export interface InvocationContext {
  sid: string
  cwd: string
  projectDir: string
  /** The agent mode id (`agentMode` on payloads). */
  agentMode?: string
  agentId?: string
  leadSid?: string
  /** Session transcript path, when known. */
  transcriptPath?: string
}

/** What the runner saw. HTTP runs map status 2xx to exit 0. */
export interface RunOutcome {
  /** Exit code. `null` when killed or never started. */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Spawn or transport error text. */
  error?: string
  durationMs: number
}

/** Result of {@link HookDialectAdapter.parse}. */
export interface ParseResult {
  hooks: CanonicalHook[]
  warnings: string[]
  /** Notes for the debug log only (an ignored key that is not a config error). */
  debug?: string[]
  /** The source asks to turn off hooks (this dialect, or all when the adapter is authoritative). */
  disableAll?: boolean
  /** Trust keys to turn off (only honored from an authoritative adapter). */
  disable?: string[]
}

/** One dialect. See SPEC.md "Adapter interface". */
export interface HookDialectAdapter {
  id: HookDialectId
  /**
   * When true, this adapter's `disableAll` and `disable` apply to every
   * dialect. Only native sets it.
   */
  authoritative?: boolean
  /** Files to read and watch, already resolved for this home and project. */
  discover(env: DiscoverEnv): SourceRef[]
  /** Parse one source. Unknown items become support-flagged entries. Never throws. */
  parse(source: SourceRef, text: string): ParseResult
  /**
   * Build the process stdin (or HTTP body) and the extra env for one call.
   * An optional `handler` replaces the hook handler for this call only (for
   * dialect placeholder substitution).
   */
  encodeInput(
    hook: CanonicalHook,
    channel: string,
    payload: unknown,
    ctx: InvocationContext,
  ): { stdin: string; env: Record<string, string>; handler?: HookHandlerSpec }
  /** Map the run outcome to a canonical result. Never throws. */
  decodeOutput(
    hook: CanonicalHook,
    channel: string,
    run: RunOutcome,
    payload: unknown,
  ): CanonicalResult
}

/** An empty `none` result. */
export function noneResult(extra: Partial<CanonicalResult> = {}): CanonicalResult {
  return { decision: "none", context: [], ...extra }
}
