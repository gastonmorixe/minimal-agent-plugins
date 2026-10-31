/**
 * Narrowed, hand-written mirrors of the host plugin-context shapes this
 * plugin reads: a MINIMAL SLICE of `types/plugin` (fields this plugin
 * actually touches), not a copy of the module. The host's real, richer
 * objects satisfy these structurally, so this stays even though the plugin
 * can now depend on `@minimal-agent/core` (S42): keeping the slice narrow
 * documents exactly what web-search reads and fails typecheck loudly if the
 * host contract drops a field this plugin needs, instead of drifting
 * silently.
 *
 * @module web-search/lib/host-types
 */

/** A tool trigger: the model called one of this plugin's tools. */
export interface ToolTrigger {
  type: "tool"
  name: string
  input: Record<string, unknown>
  tool_use_id?: string
}

/** Runtime context passed to tool-call handlers. Narrowed to fields web-search reads. */
export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  log: PluginLogger
}

/** Structured logger the host injects (syslog-style levels). */
export interface PluginLogger {
  emergency(scope: string, message: string): void
  alert(scope: string, message: string): void
  critical(scope: string, message: string): void
  error(scope: string, message: string): void
  warn(scope: string, message: string): void
  notice(scope: string, message: string): void
  info(scope: string, message: string): void
  debug(scope: string, message: string): void
}

/** A tool handler's return value. Mirror of the host's TUIResult union subset. */
export type TUIResult =
  | {
      kind: "tool_result"
      content: string
      is_error?: boolean
      display?: string
      displayHeader?: string
      displayFooter?: string
      suppressToolTime?: boolean
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }
