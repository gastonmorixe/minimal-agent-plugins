// source: plugin-api/src/types/plugin.ts (local structural mirror; keep in sync)
/**
 * Local structural mirrors of the host plugin-context types the schedule
 * plugin consumes. External plugins cannot import
 * `@minimal-agent/plugin-api/types/plugin` at runtime from the sibling repo
 * clone (type-only imports are erased, but we keep a local mirror so the plugin
 * type-checks standalone and never reaches into core `src/`).
 *
 * Each interface is NARROWED to the fields schedule actually reads. If the host
 * shape changes in a way schedule depends on, its integration test (host-run
 * against the real loader) fails and this mirror is updated.
 *
 * @module schedule/lib/host-types
 */

/** Fire-and-forget emit onto the shared plugin event bus. */
export type EmitFn = (channel: string, payload?: unknown) => void

/** Boot-time agent identity. */
export interface AgentContext {
  /** Per-process session uuid. */
  readonly sessionId: string
  /** Agent process id. */
  readonly pid: number
  /** Resolved model id the agent runs on. */
  readonly model: string
  /** Agent semver. */
  readonly version: string
}

/** Structured logger the host injects into command handlers. */
export interface PluginLogger {
  debug(scope: string, message: string): void
  info(scope: string, message: string): void
  warn(scope: string, message: string): void
  error(scope: string, message: string): void
}

/** A tool trigger: the model called one of this plugin's tools. */
export interface ToolTrigger {
  type: "tool"
  name: string
  input: Record<string, unknown>
  tool_use_id?: string
}

/**
 * Runtime context passed to a tool-call handler. Mirror of the host's
 * `TUIContext`, narrowed to the fields schedule's cron_* handlers consume.
 */
export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Environment dict. */
  env: Record<string, string>
  /** Cancelled when the user aborts the turn or a timeout fires. */
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}

/** A tool handler's return value. Mirror of the host's `TUIResult`. */
export type TUIResult =
  | {
      kind: "tool_result"
      content: string
      is_error?: boolean
      display?: string
      displayHeader?: string
      displayFooter?: string
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

/**
 * Runtime context passed to a slash-command handler. Mirror of the host's
 * `CommandContext`, narrowed to the fields schedule's cmd_loop / cmd_schedule
 * read (name, argv, cwd, env, emit, agent).
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
 * A framed notice block: the host owns the frame chrome, the plugin supplies
 * the content. Mirror of the host's `CommandNoticeBlock`.
 */
export interface CommandNoticeBlock {
  /** Leading glyph rendered before the title. */
  icon?: string
  /** Short heading, e.g. `"loop"` or `"schedule"`. */
  title: string
  /** Secondary header text rendered after the title. */
  info?: string
  /** Optional trailing header timestamp. */
  timestamp?: string
  /** Body rows. ANSI is preserved; the host owns only the frame chrome. */
  body?: string[]
  /** Footer text rendered on the closing row. */
  footer?: string
  /** Host palette key for frame/icon/title chrome. Unknown values fall back. */
  color?: string
}

/**
 * The `CommandResult` variants schedule returns (`notice` with `lines` or a
 * framed `block`, and `error`). Mirror of the host's `CommandResult` union;
 * the `expand` variant schedule does not produce is omitted.
 */
export type CommandResult =
  | { kind: "notice"; lines?: string[]; block?: CommandNoticeBlock }
  | { kind: "error"; message: string }
  | { kind: "none" }

/**
 * Runtime context passed to a live-area slot handler (the heartbeat). Mirror of
 * the host's `LiveAreaHandlerContext`, narrowed to what schedule's heartbeat
 * reads: tick, emit, cwd, env, abort.
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
  /** Fire-and-forget emit onto the shared plugin event bus. */
  emit?: EmitFn
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}
