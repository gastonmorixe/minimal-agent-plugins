/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Why local copies?
 *   External plugins don't sit inside the agent's source tree, so the
 *   `../../../src/plugins/types.ts` import that embedded plugins use isn't
 *   available, and a plugin should not reach into the agent's modules anyway.
 *   It talks to the host only through the shared context the loader passes in.
 *   TypeScript types are structural and erased at runtime, so a local mirror
 *   lets us type-check this plugin standalone (bun test, editor IntelliSense)
 *   while staying byte-compatible with the agent's real contract.
 *
 * If the agent's contract changes, update this file. The fields we use are
 * intentionally narrow.
 *
 * @module lib/host-types
 */

/**
 * Boot-time identity of the host agent, shared with every handler context.
 * Mirror of `src/plugins/types.ts:AgentContext`. We read `sessionId` to
 * colocate job state with the session, and `pid` for diagnostics.
 */
export interface AgentContext {
  /** Per-process session uuid. Same value the host's `getSessionId()` returns. */
  readonly sessionId: string
  /** Agent process id. */
  readonly pid: number
  /** Resolved model id the agent runs on. */
  readonly model: string
  /** Agent semver. */
  readonly version: string
}

/** A tool trigger: the model called one of this plugin's tools. */
export interface ToolTrigger {
  type: "tool"
  /** The tool name as declared in the manifest (`BackgroundRun` etc.). */
  name: string
  /** Raw input the model produced. Validate before use. */
  input: Record<string, unknown>
  /** The tool_use id from the wire protocol. */
  tool_use_id?: string
}

/**
 * Runtime context passed to a tool-call handler. Mirror of
 * `src/plugins/types.ts:TUIContext`, narrowed to the fields we consume.
 */
export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Environment dict. The loader injects `TUI_PLUGIN_PROTOCOL=1` and friends. */
  env: Record<string, string>
  /** Cancelled when the user aborts the turn or a timeout fires. */
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}

/** A handler's return value. Mirror of `src/plugins/types.ts:TUIResult`. */
export type TUIResult =
  | {
      kind: "tool_result"
      /** Sent back to the model. */
      content: string
      is_error?: boolean
      /** Optional ANSI body rendered in the transcript (no truncation). */
      display?: string
      /** Optional header content slot (after the icon+label). */
      displayHeader?: string
      /** Optional footer content slot (after the closing glyph). */
      displayFooter?: string
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

export type TUIHandler = (ctx: TUIContext) => Promise<TUIResult>

/**
 * Runtime context passed to a live-area slot handler. Mirror of
 * `src/plugins/types.ts:LiveAreaHandlerContext`, narrowed to what we use.
 *
 * A slot is invoked at REPL start and then every `refreshMs`. It returns a
 * string (the row to paint), `null` (clear the row), or throws (clear + log).
 */
export interface LiveAreaHandlerContext {
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. */
  env: Record<string, string>
  /** Aborts when the per-invocation timeout fires or the REPL is closing. */
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  /** Monotonically increasing tick counter for this slot (0 on first call). */
  tick: number
  /**
   * Fire-and-forget emit onto the shared plugin event bus. Used to inject a
   * completion digest between turns via `emit("prompt.inject", {text, source})`.
   * Optional and best-effort: `undefined` (or a no-op) when constructed without
   * a bus (some tests).
   */
  emit?: (channel: string, payload?: unknown) => void
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}

export type LiveAreaHandler = (
  ctx: LiveAreaHandlerContext,
) => Promise<string | null> | string | null
