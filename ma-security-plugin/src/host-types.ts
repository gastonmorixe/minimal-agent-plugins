/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin uses. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only. Types
 * are structural and erased at runtime, so the real host objects satisfy
 * these while we type-check and unit-test standalone.
 *
 * Source of truth in the host: core `src/sdk/lifecycle.ts` (hook payloads)
 * and `plugin-api/src/types/plugin.ts` (`TUIContext`, `TUIResult`,
 * `CommandContext`, `CommandResult`). Keep this narrow and update it when the
 * host contract changes.
 *
 * @module src/host-types
 */

/** Plugin-scoped diagnostic logger. Any object of no-op methods fits. */
export type PluginLogger = Record<string, (...args: unknown[]) => void>

/** Minimal content block shape (text, tool_use, tool_result, others). */
export interface ContentBlock {
  type: string
  [key: string]: unknown
}

/** Minimal message shape on the send snapshot. */
export interface Message {
  role: string
  content: string | ContentBlock[]
  [key: string]: unknown
}

/** `message.willSend` payload. Listeners may rewrite `messages` / `system`. */
export interface SendSnapshot {
  messages: Message[]
  system: string | ContentBlock[]
  model: string
  providerId?: string
}

/** `tool.willInvoke` payload. */
export interface ToolWillInvokePayload {
  tool: string
  toolUseId: string
  input: Record<string, unknown>
  cwd: string
  agentId?: string
  leadSid?: string
}

/** `turn.willStart` payload. */
export interface TurnWillStartPayload {
  text: string
}

/** One finished tool call in a batch. */
export interface ToolBatchItem {
  tool: string
  toolUseId: string
  ok: boolean
}

/** `tool.didBatch` payload. */
export interface ToolDidBatchPayload {
  results: ToolBatchItem[]
}

/**
 * Result a `chain` listener returns. Mirrors core
 * `src/plugins/hooks/types.ts` `ChainResult<T>` exactly. `void` (or
 * `undefined`) is pass-through. Core applies a rewrite only when the result
 * has a `payload` key, so a bare rewritten object is silently dropped.
 * `{halt: true}` short-circuits the chain.
 */
export type ChainResult<T> =
  | void
  | { payload: T }
  | { payload: T; halt: true }
  | { halt: true; reason?: string }

/** What a TUI handler was triggered by. */
export type TUITrigger =
  | { type: "tool"; name: string; input: Record<string, unknown>; tool_use_id: string }
  | { type: "inline_tag"; name: string; body: string }

/** The slice of `TUIContext` this plugin reads. */
export interface TUIContext {
  trigger: TUITrigger
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  log: PluginLogger
}

/** `tool_result` arm of the host `TUIResult` union. */
export interface TUIResult {
  kind: "tool_result"
  content: string
  is_error?: boolean
  display?: string
}

/** The slice of `CommandContext` this plugin reads. */
export interface CommandContext {
  name: string
  argv: string
  rawLine: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  log: PluginLogger
}

/** Command result arms this plugin returns. */
export type CommandResult =
  | { kind: "notice"; lines?: string[] }
  | { kind: "error"; message: string }
  | { kind: "none" }
