/**
 * LOCAL structural re-declaration of the slice of minimal-agent's plugin
 * contract this plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host objects the loader passes satisfy
 * these while we type-check + unit-test standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`CommandContext`, `CommandResult`, `HookHandlerContext`). The bus-payload
 * shapes below are not host-exported types; they mirror the wire shapes.
 * Keep this narrow and update it if the host contract changes.
 *
 * Same pattern as `ma-slash-menu-plugin/lib/host-types.ts`.
 *
 * @module config/lib/host-types
 */

/**
 * Fire-and-forget emit onto the shared plugin bus. Mirror of the `emit`
 * field on the host's command / hook contexts.
 */
export type EmitFn = (channel: string, payload?: unknown) => void

/** Boot-time agent identity. Mirror of the host's `AgentContext`. */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

/** Plugin-scoped diagnostic logger. Mirror of the host's `PluginLogger`. */
export interface PluginLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

/**
 * The slice of `CommandContext` the config command reads (argv, cwd, env,
 * emit) plus the fields the integration test constructs so the mirror stays
 * assignable from a full host context literal. Mirror of the host's
 * `CommandContext`.
 */
export interface CommandContext {
  name: string
  argv: string
  rawLine: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  log: PluginLogger
  emit: EmitFn
  agent?: AgentContext
}

/**
 * The `CommandResult` variants this command returns. Mirror of the host's
 * `CommandResult` union (we return `notice`, `error`, and `none`; the
 * `expand` / `block` variants we don't produce are omitted).
 */
export type CommandResult =
  | { kind: "notice"; lines?: string[] }
  | { kind: "error"; message: string }
  | { kind: "none" }

/**
 * The slice of `HookHandlerContext` the key handler reads: just the bus
 * emitter. Mirror of the host's `HookHandlerContext`.
 */
export interface HookHandlerContext {
  emit: EmitFn
}

/** Payload of the `editor.key` broadcast-sync channel. */
export interface EditorKeyPayload {
  key: string
  buffer: string
  cursor: {
    row: number
    col: number
    visualRow: number
    rowsInLogicalLine: number
    totalLines: number
  }
  result: {
    halt?: boolean
    buffer?: string
    cursor?: { row: number; col: number }
  }
}

/** Payload of the `editor.buffer.changed` broadcast-async channel. */
export interface BufferChangedPayload {
  text: string
  cursor: { row: number; col: number }
}
