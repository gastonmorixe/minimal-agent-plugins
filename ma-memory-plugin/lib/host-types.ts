/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host contexts the loader passes satisfy
 * these while we type-check standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts` (`TUIContext`,
 * `TUITrigger`, `TUIResult`, `PromptFragmentContext`) and
 * `plugin-api/src/types/host-capabilities.ts` (`PluginHost` / `LlmCompleteApi`).
 * Kept to the fields the handlers + their tests use.
 *
 * @module memory/lib/host-types
 */

/**
 * Free-form key/value pairs serialized into RFC 5424 STRUCTURED-DATA.
 * Mirror of the host's `StructuredData`.
 */
export type StructuredData = Readonly<Record<string, string | number | boolean>>

/**
 * Plugin-scoped syslog-style logger. Mirror of the host's `PluginLogger`
 * (`plugin-api/src/types/logger.ts`): eight RFC 5424 severity methods, each
 * `(source, message, sd?) => void`. Structural, so the host's real logger and
 * any test stub with this shape satisfy it.
 */
export interface PluginLogger {
  emergency(source: string, message: string, sd?: StructuredData): void
  alert(source: string, message: string, sd?: StructuredData): void
  critical(source: string, message: string, sd?: StructuredData): void
  error(source: string, message: string, sd?: StructuredData): void
  warn(source: string, message: string, sd?: StructuredData): void
  notice(source: string, message: string, sd?: StructuredData): void
  info(source: string, message: string, sd?: StructuredData): void
  debug(source: string, message: string, sd?: StructuredData): void
}

/** What triggered a TUI handler. Mirror of the host's `TUITrigger`. */
export type TUITrigger =
  | {
      type: "inline_tag"
      name: string
      attrs: Record<string, string>
      body: string
      self_closing: boolean
    }
  | {
      type: "tool"
      name: string
      input: Record<string, unknown>
      tool_use_id: string
    }

/**
 * The slice of `TUIContext` the memory tool/inline handlers read, plus the
 * fields their tests construct. Mirror of the host's `TUIContext`.
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
}

/** The result a memory handler returns. Mirror of the relevant `TUIResult` arms. */
export type TUIResult =
  | { kind: "rendered"; ansi: string }
  | { kind: "tool_result"; content: string; is_error?: boolean; display?: string }

// ---------------------------------------------------------------------------
// Capability host (llm:complete)
// ---------------------------------------------------------------------------

/** A one-shot host-brokered completion request. Mirror of `LlmCompleteRequest`. */
export interface LlmCompleteRequest {
  model?: string
  system: string
  userText: string
  maxTokens?: number
  timeoutMs?: number
}

/** The `llm:complete` capability. Mirror of the host's `LlmCompleteApi`. */
export interface LlmCompleteApi {
  complete(req: LlmCompleteRequest): Promise<string>
}

/** The capability host slice this plugin narrows. Mirror of `PluginHost`. */
export interface PluginHost {
  llm?: LlmCompleteApi
}

/**
 * The slice of `PromptFragmentContext` the memory-load fragment reads (cwd +
 * the capability host for `ctx.host.llm.complete`), plus the fields the load
 * test constructs. Mirror of the host's `PromptFragmentContext`.
 */
export interface PromptFragmentContext {
  packageDir: string
  cwd: string
  env: Record<string, string>
  sessionId?: string
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  log: PluginLogger
  host?: PluginHost
}
