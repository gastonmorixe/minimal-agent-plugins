/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Source of truth: plugin-api/src/types/plugin.ts. Minimal slice — only
 * fields this plugin uses (and the fields its own tests construct).
 *
 * External plugins live outside the agent's source tree, so they can't import
 * `@minimal-agent/plugin-api` or core `src/` at runtime. TypeScript types are
 * structural and erased at runtime, so a local minimal-slice mirror lets this
 * plugin type-check standalone while staying byte-compatible with the host.
 *
 * @module lib/host-types
 */

/** Boot-time agent identity. This plugin reads `sessionId`. */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

/** Plugin-scoped diagnostic logger. This plugin calls `log.warn`. */
export interface PluginLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** Live model + capability snapshot. This plugin reads `tools.userDefined`. */
export interface ModelInfoSnapshot {
  tools: { userDefined: boolean; parallel: boolean }
  [key: string]: unknown
}

/** What triggered a tool handler. This plugin reads the `tool` variant. */
export type TUITrigger =
  | {
      type: "tool"
      name: string
      input: Record<string, unknown>
      tool_use_id: string
    }
  | {
      type: "inline_tag"
      name: string
      attrs: Record<string, string>
      body: string
      self_closing: boolean
    }

/**
 * Runtime context passed to a tool handler. The plugin reads `trigger`, `env`,
 * and `packageDir`; the remaining required fields are carried because the
 * plugin's own tests construct the full context literal.
 */
export interface TUIContext {
  trigger: TUITrigger
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  log: PluginLogger
  agent?: AgentContext
  queryModelInfo?: () => ModelInfoSnapshot | undefined
}

/**
 * Handler result. Minimal slice: this plugin returns the `tool_result` variant
 * (content, display, displayHeader, displayFooter, is_error, suppressToolTime).
 */
export type TUIResult = {
  kind: "tool_result"
  content: string
  is_error?: boolean
  display?: string
  displayHeader?: string
  displayFooter?: string
  suppressToolTime?: boolean
}

/**
 * Context passed to a prompt-fragment producer. This plugin reads
 * `queryModelInfo`, `packageDir`, and `log`.
 */
export interface PromptFragmentContext {
  packageDir: string
  cwd: string
  env: Record<string, string>
  sessionId?: string
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  log: PluginLogger
  agent?: AgentContext
  queryModelInfo?: () => ModelInfoSnapshot | undefined
}

/**
 * Runtime context passed to an event-subscription handler. This plugin reads
 * `agent.sessionId`, `payload`, and `env.HOME`.
 */
export interface EventHandlerContext<TPayload = unknown> {
  event: string
  payload: TPayload
  packageDir: string
  cwd: string
  env: Record<string, string>
  emit: (event: string, payload?: unknown) => void
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  log: PluginLogger
  agent?: AgentContext
}

/** Event-subscription handler default-export signature. */
export type EventHandler<TPayload = unknown> = (
  ctx: EventHandlerContext<TPayload>,
) => void | Promise<void>
