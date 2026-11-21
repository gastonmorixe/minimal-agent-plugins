// source of truth: plugin-api/src/types/host-capabilities.ts + plugin-api/src/types/plugin.ts
/**
 * Local structural mirror of the host contract slice that the title plugin
 * reads. A plugin must be able to live in its own repository, so it does not
 * import host runtime code. TypeScript types are structural and erased at
 * runtime, so the real host objects that the loader passes satisfy these
 * types.
 *
 * Keep each mirror a MINIMAL SLICE: only the fields this plugin reads or
 * sends. Update this file when the host contract changes.
 *
 * Host sources:
 * - `EventHandlerContext`, `RunModeFact`, `PromptSubmittedPayload`,
 *   `UtilityModelRecommendation`: `plugin-api/src/types/plugin.ts`
 * - `ModelsReadApi`, `ResolvedUtilityModel`, `LlmSideRequest`,
 *   `LlmSideResult`, `SessionMetaApi`, `SessionTitleState`,
 *   `SessionsReadApi`, `SessionMetaView`:
 *   `plugin-api/src/types/host-capabilities.ts`
 * - `TitleSideband`: `plugin-api/src/types/sideband.ts` (`SidebandApi`)
 * - `reason` (result): core `src/plugins/host/providers/llm-side.ts`
 *   (`LlmSideResultCore`). It is not in the plugin-api types yet.
 *
 * @module lib/host-types
 */

/**
 * The slice of the session sideband API (`ctx.sideband`) that the plugin
 * reads. Mirror of `SidebandApi.ready`, `has` and `strip`
 * (`plugin-api/src/types/sideband.ts`).
 */
export interface TitleSideband {
  /** False when no codec is loaded. Then `strip` cannot find a tag. */
  readonly ready: boolean
  has(text: string): boolean
  strip(text: string, q?: { lenient?: boolean; keepBody?: boolean }): string
}

/** Plugin-scoped diagnostic logger. Mirror of the host `PluginLogger`. */
export interface PluginLogger {
  info(source: string, msg: string): void
  warn(source: string, msg: string): void
  error(source: string, msg: string): void
  debug(source: string, msg: string): void
}

/** How the host process runs. Mirror of the host `RunMode`. */
export type RunMode = "repl" | "one-shot" | "stream-json" | "host" | "subagent"

/** Run-mode fact (`ctx.run`). Mirror of the host `RunModeFact`. */
export interface RunModeFact {
  mode: RunMode
  interactive: boolean
  subagent?: { id: string; role?: string; leadSid?: string }
  /** The live session provider. */
  providerId?: string
  dryRun?: boolean
}

/** Origin of the prompt text. Mirror of the host `PromptSource`. */
export type PromptSource = "user" | "command" | "expand" | "recovery" | "continue" | "inject"

/** `prompt.submitted` payload. Mirror of the host `PromptSubmittedPayload`. */
export interface PromptSubmittedPayload {
  text: string
  cwd: string
  sid: string | null
  exit: "submitted" | "canceled"
  queuePos: number
  source?: PromptSource
}

/** Price slice of the host `ModelRate` ($ per M tokens). */
export interface ModelRate {
  inputUSD: number
  outputUSD: number
}

/** Slice of the host `ModelView`. */
export interface ModelView {
  id: string
  providerId: string
  tags?: ReadonlyArray<string>
  capabilities: { structuredOutputs: boolean }
  pricing: ModelRate
}

/** Reasoning effort of a title call. */
export type TitleEffort = "low" | "medium" | "high"

/**
 * Stream mode of the title profile. `"off"`: the adapter accepts a non-stream
 * request. `"required"` (or absent): the core streams and collects the text.
 */
export type TitleStreamMode = "off" | "required"

/**
 * Result of `models.utilityFor`: the title profile of a provider. Mirror of
 * the host `ResolvedUtilityModel`.
 */
export interface ResolvedUtilityModel {
  modelId: string
  providerId: string
  structured: "json_schema" | "none"
  thinkingOff?: boolean
  effort?: TitleEffort
  stream?: TitleStreamMode
  pricing?: ModelRate
}

/**
 * Adapter recommendation of a provider (`recommendUtilityModel?()`). Mirror
 * of the host `UtilityModelRecommendation`. The plugin reads it through
 * `models.utilityFor`, which wraps the adapter method.
 */
export interface UtilityModelRecommendation {
  modelId: string
  structured: "json_schema" | "none"
  thinkingOff?: boolean
  effort?: TitleEffort
  stream?: TitleStreamMode
}

/** `models:read` slice. Mirror of the host `ModelsReadApi`. */
export interface ModelsReadApi {
  find(idOrAlias: string): ModelView | undefined
  findForProvider(idOrAlias: string, providerId: string): ModelView | undefined
  list(): ModelView[]
  findByTags(providerId: string, mustHave: readonly string[]): ModelView | undefined
  /** The title profile of the provider (no tag fallback). Optional: older hosts. */
  utilityFor?(providerId?: string): ResolvedUtilityModel | undefined
}

/** JSON-schema output request. Mirror of the host `LlmSideOutputSchema`. */
export interface LlmSideOutputSchema {
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

/** Side-call request. Mirror of the host `LlmSideRequest`. */
export interface LlmSideRequest {
  model?: string
  system: string
  userText: string
  maxTokens?: number
  timeoutMs?: number
  purpose?: "title" | "summary" | "aux"
  outputSchema?: LlmSideOutputSchema
  thinking?: "off" | "default"
  effort?: TitleEffort
  abortSignal?: AbortSignal
  maxUsdPerMTokIn?: number
}

/** Side-call usage. Mirror of the host `LlmSideUsage`. */
export interface LlmSideUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Side-call result. Mirror of the host `LlmSideResult` (+ core extras). */
export interface LlmSideResult {
  text: string
  json?: unknown
  stopReason: string
  model: string
  provider: string
  usage: LlmSideUsage
  costUsd?: number
  latencyMs: number
  /** Core `LlmSideResultCore` extra: the precise cause of an `error`. */
  reason?: string
}

/** `llm:complete` slice. Only `request` is used. */
export interface LlmCompleteApi {
  /** Optional: older hosts. */
  request?(req: LlmSideRequest): Promise<LlmSideResult>
}

/** Origin of a title. Mirror of the host `TitleSource`. */
export type TitleSource = "ai" | "user" | "derived"

/** Usage on a title line. Mirror of the host `SessionTitleUsage`. */
export interface SessionTitleUsage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

/** One title line. Mirror of the host `SessionTitleRecordView`. */
export interface SessionTitleRecordView {
  kind: "title"
  v: 1
  sid: string
  title: string
  source: TitleSource
  model?: string
  provider?: string
  usage?: SessionTitleUsage
  at: string
}

/** Merged title state of one sid. Mirror of the host `SessionTitleState`. */
export interface SessionTitleState {
  ai?: SessionTitleRecordView
  user?: SessionTitleRecordView
  derived?: SessionTitleRecordView
}

/** Input of `setTitle`. Mirror of the host `SessionTitleInput`. */
export interface SessionTitleInput {
  sid: string
  title: string
  source: TitleSource
  model?: string
  provider?: string
  usage?: SessionTitleUsage
}

/** `sessions:meta`. Mirror of the host `SessionMetaApi`. */
export interface SessionMetaApi {
  getTitle(sid: string): SessionTitleState
  setTitle(input: SessionTitleInput): Promise<void>
}

/** Slice of the host `SessionMetaView` (`sessions.meta`). */
export interface SessionMetaViewSlice {
  readonly sid: string
  /** The sid of the session that this session was forked from, or null. */
  readonly parentSid: string | null
}

/** `sessions:read` slice. Mirror of the host `SessionsReadApi`. */
export interface SessionsReadApi {
  /** The saved title (user, AI, then derived), or null. */
  title(sid: string): string | null
  /** Session metadata. Null when the sid is not known. */
  meta(sid: string): Promise<SessionMetaViewSlice | null>
}

/** The host slice that the title handler reads (`ctx.host`). */
export interface TitleHost {
  readonly llm?: LlmCompleteApi
  readonly sessionMeta?: SessionMetaApi
  readonly models?: ModelsReadApi
  /** `sessions:read`. Optional: older hosts. */
  readonly sessions?: SessionsReadApi
}

/** Slice of the host `AgentContext`. */
export interface AgentContext {
  readonly sessionId: string
  readonly model: string
}

/** Slice of the host `EventHandlerContext` that the handler reads. */
export interface EventHandlerContext<TPayload = unknown> {
  event: string
  payload: TPayload
  env: Record<string, string>
  emit: (event: string, payload?: unknown) => void
  abort: AbortSignal
  log: PluginLogger
  agent?: AgentContext
  /** Set only with `"host": true` in the manifest event subscription. */
  host?: TitleHost
  run?: RunModeFact
  /** The session sideband API. Optional: older hosts. */
  sideband?: TitleSideband
}

/** An event handler. Mirror of the host `EventHandler`. */
export type EventHandler<TPayload = unknown> = (
  ctx: EventHandlerContext<TPayload>,
) => void | Promise<void>
