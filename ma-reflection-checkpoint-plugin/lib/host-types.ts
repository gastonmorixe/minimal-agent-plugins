/**
 * LOCAL structural re-declaration of the host surfaces this plugin uses.
 *
 * An external plugin must not import host code, also not type-only, so it
 * can live in its own repository. Thus this file declares only the slice of
 * the host contexts that this plugin reads. The types are structural and
 * erased at runtime, so the real host objects satisfy them.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`TUIContext`, `TUITrigger`, `TUIResult`, `HookHandlerContext`,
 * `CountdownFn`, `RunModeFact`, `PromptFragmentContext`), `plugin-api/src/types/sideband.ts`
 * (`SidebandApi`) and `src/sdk/lifecycle.ts`
 * (`ToolDidBatchPayload`).
 *
 * @module lib/host-types
 */

/** Boot-time agent identity. Mirror of `AgentContext` (we read `sessionId`). */
export interface AgentContext {
  readonly sessionId: string
}

/** How a countdown wait ended. Mirror of `CountdownResult`. */
export type CountdownResult = "elapsed" | "skipped" | "aborted"

/** One countdown request. Mirror of `CountdownRequest`. */
export interface CountdownRequest {
  id: string
  label: string
  ms: number
  signal?: AbortSignal
}

/** Host countdown with skip. Mirror of `CountdownFn`. */
export type CountdownFn = (request: CountdownRequest) => Promise<CountdownResult>

/** Run-mode fact. Mirror of `RunModeFact` (we read `interactive`). */
export interface RunModeFact {
  mode: string
  /** True only for a REPL with stdin and stdout on a TTY. */
  interactive: boolean
}

/** The plugin-scoped logger slice this plugin uses. Mirror of `PluginLogger`. */
export interface PluginLogger {
  info(message: string, data?: Record<string, unknown>): void
}

/**
 * The slice of the session sideband API that this plugin uses. Mirror of
 * `SidebandApi.render` (we render the `reflection-checkpoint` tag).
 */
export interface SidebandRender {
  render(kind: string, msg?: { attrs?: Record<string, string | number> }): string
}

/** The slice of `HookHandlerContext` the `tool.didBatch` listener reads. */
export interface HookContext {
  env: Record<string, string>
  abort: AbortSignal
  agent?: AgentContext
  /** Run-mode fact. `undefined` when the host gives none (treat as not interactive). */
  run?: RunModeFact
  countdown: CountdownFn
  log?: PluginLogger
  /** The session sideband API. It renders the checkpoint tag. With none, no tag line. */
  sideband?: SidebandRender
}

/** One finished tool call in a batch. Mirror of `ToolBatchItem`. */
export interface ToolBatchItem {
  tool: string
  toolUseId: string
  ok: boolean
}

/** Chain payload for `tool.didBatch`. Mirror of `ToolDidBatchPayload`. */
export interface ToolDidBatchPayload {
  results: ToolBatchItem[]
  /** 1-based index of this tool round in the current run. */
  round: number
}

/** The chain result arm this listener returns. Mirror of `ChainResult`. */
export type DidBatchResult = void | { additionalContext: string[] }

/** The trigger variants of an inline-tag handler. Mirror of `TUITrigger`. */
export type TUITrigger =
  | { type: "inline_tag"; name: string; attrs: Record<string, string>; body: string }
  | { type: "tool" }

/** The slice of `TUIContext` the inline-tag handler reads. */
export interface TUIContext {
  trigger: TUITrigger
  env: Record<string, string>
  agent?: AgentContext
  log?: PluginLogger
}

/** The `rendered` result variant. Mirror of `TUIResult`. */
export type TUIResult = { kind: "rendered"; ansi: string }

/** The slice of `PromptFragmentContext` the fragment handler reads. */
export interface FragmentContext {
  env: Record<string, string>
}
