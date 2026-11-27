/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Why local copies? External plugins don't sit inside the agent's source
 * tree, so a `../../../src/plugins/types.ts` import isn't available. Types
 * are structural and erased at runtime, so a local mirror lets this plugin
 * type-check standalone while staying byte-compatible with the host.
 *
 * Only the fields actually used are typed.
 *
 * @module lib/host-types
 */

// ---------------------------------------------------------------------------
// Tool handler contract
// ---------------------------------------------------------------------------

export interface ToolTrigger {
  type: "tool"
  name: string
  input: Record<string, unknown>
}

export interface PluginLogger {
  emergency(source: string, message: string, sd?: Record<string, unknown>): void
  alert(source: string, message: string, sd?: Record<string, unknown>): void
  critical(source: string, message: string, sd?: Record<string, unknown>): void
  error(source: string, message: string, sd?: Record<string, unknown>): void
  warn(source: string, message: string, sd?: Record<string, unknown>): void
  notice(source: string, message: string, sd?: Record<string, unknown>): void
  info(source: string, message: string, sd?: Record<string, unknown>): void
  debug(source: string, message: string, sd?: Record<string, unknown>): void
}

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

export type TUIResult =
  | {
      kind: "tool_result"
      content: string
      is_error?: boolean
      display?: string
      displayHeader?: string
      displayFooter?: string
      _truncCtx?: { totalBytes: number; totalLines: number; tool?: string }
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

export type TUIHandler = (ctx: TUIContext) => Promise<TUIResult>

// ---------------------------------------------------------------------------
// Hook + event contracts
// ---------------------------------------------------------------------------

export interface HookHandlerContext {
  channel: string
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  priority: number
  emit: (channel: string, payload?: unknown) => void
  listCommands?: () => CommandInfo[]
  stderr: NodeJS.WriteStream
}

export interface EventHandlerContext<TPayload = unknown> {
  event: string
  payload: TPayload
  packageDir: string
  cwd: string
  env: Record<string, string>
  emit: (event: string, payload?: unknown) => void
  listCommands?: () => CommandInfo[]
  abort: AbortSignal
  stderr: NodeJS.WriteStream
}

export interface CommandInfo {
  name: string
  summary: string
  argHint?: string
  pluginId: string
}
