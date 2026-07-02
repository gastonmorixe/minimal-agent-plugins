/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host context the loader passes satisfies
 * these while we type-check standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts` (`TUIContext`,
 * `TUIResult`), `plugin-api/src/types/host-capabilities.ts` (`ModelView`,
 * `ModelsReadApi`, `SessionInfoReadApi`, `SessionTokensView`), and
 * `plugin-api/src/llm/provider-plugin.ts` (`ProviderSessionInfo`,
 * `QuotaSnapshot`, `QuotaWindow`, `Capabilities`). Kept to the slices the
 * gather/handler code reads.
 *
 * @module session-info/lib/host-types
 */

// ---------------------------------------------------------------------------
// Model registry view (models:read)
// ---------------------------------------------------------------------------

/** Thinking capability. Mirror of the slice of `Capabilities.thinking`. */
export interface ThinkingCapability {
  adaptive: boolean
  extended: boolean
  interleaved: boolean
  visible: boolean
}

/** Per-model pricing (USD per Mtok). Mirror of the slice of `ModelRate`. */
export interface ModelRateView {
  inputUSD: number
  outputUSD: number
  cacheWriteUSD: number
  cacheReadUSD: number
}

/** Model capabilities. Mirror of the slice of `Capabilities` this plugin reads. */
export interface CapabilitiesView {
  speedFast: boolean
  contextWindow: number
  thinking: ThinkingCapability
}

/** A registered model. Mirror of the leaf `ModelView` (read slice). */
export interface ModelView {
  id: string
  displayName: string
  providerId: string
  capabilities: CapabilitiesView
  pricing: ModelRateView
}

/** The `models:read` capability. Mirror of `ModelsReadApi` (read slice). */
export interface ModelsReadApi {
  resolve(idOrAlias: string): ModelView
  find(idOrAlias: string): ModelView | undefined
}

// ---------------------------------------------------------------------------
// Provider session info (session-info:read)
// ---------------------------------------------------------------------------

/** One plan/rate-limit window. Mirror of the leaf `QuotaWindow`. */
export interface QuotaWindow {
  id: string
  utilization: number
  resetAtMs?: number
}

/** Provider quota snapshot. Mirror of the leaf `QuotaSnapshot`. */
export interface QuotaSnapshot {
  windows: QuotaWindow[]
  overage?: { active: boolean }
}

/** The active provider's per-session snapshot. Mirror of `ProviderSessionInfo`. */
export interface ProviderSessionInfo {
  contextWindow?: number
  modelLabel?: string
  quota?: QuotaSnapshot
}

/** Cumulative session token counters. Mirror of `SessionTokensView`. */
export interface SessionTokensView {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  total: number
  turns: number
  contextSize: number
}

/** The `session-info:read` capability. Mirror of `SessionInfoReadApi`. */
export interface SessionInfoReadApi {
  providerInfo(
    modelId: string,
    opts?: { signal?: AbortSignal; providerId?: string },
  ): Promise<ProviderSessionInfo>
  tokens(): SessionTokensView
}

// ---------------------------------------------------------------------------
// Capability host + TUI context
// ---------------------------------------------------------------------------

/** The capability host slice this plugin narrows. Mirror of `PluginHost`. */
export interface PluginHost {
  models?: ModelsReadApi
  sessionInfo?: SessionInfoReadApi
}

/** Boot-time agent identity. Mirror of the slice of `AgentContext` we read. */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

/**
 * What triggered the handler. Mirror of the host's `TUITrigger` `tool` arm.
 */
export type TUITrigger =
  | { type: "tool"; name: string; input: Record<string, unknown>; tool_use_id: string }
  | { type: "inline_tag"; name: string; body: string }

/**
 * The slice of `TUIContext` this plugin reads: the trigger, cwd, env, the
 * optional agent identity, and the capability host (`models` + `sessionInfo`).
 * The `queryModelInfo` live-model hook is read via a structural cast in
 * gather.ts, so it is not declared here. Mirror of the host's `TUIContext`.
 */
export interface TUIContext {
  trigger: TUITrigger
  cwd: string
  env: Record<string, string>
  agent?: AgentContext
  host?: PluginHost
}

/** The `tool_result` result this handler returns. Mirror of `TUIResult`. */
export interface TUIResult {
  kind: "tool_result"
  content: string
  is_error?: boolean
  displayHeader?: string
}
