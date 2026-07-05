// source of truth: plugin-api/src/types/host-capabilities.ts + plugin-api/src/types/plugin.ts + plugin-api/src/llm/provider-plugin.ts
/**
 * Local structural mirrors of the host contract types this plugin consumes.
 *
 * External plugins can't import `@minimal-agent/plugin-api` at runtime (the
 * cloned plugins repo has no node_modules), and TypeScript types are erased at
 * runtime anyway, so a local mirror lets the plugin type-check standalone while
 * staying byte-compatible with the host contract. A stale mirror fails
 * typecheck loudly (unlike vendored runtime code, which could drift silently),
 * so mirroring the type surface is the safe, self-contained choice.
 *
 * Keep each mirror a MINIMAL SLICE: only the fields this plugin reads. Update
 * here if the host contract changes.
 *
 * @module lib/host-types
 */

import type { Capabilities } from "./capabilities.ts"

/**
 * Per-model USD rate table. Mirror of host `ModelRate`
 * (types/host-capabilities.ts). Ollama's pricing.ts builds these.
 */
export interface ModelRate {
  inputUSD: number
  outputUSD: number
  cacheWriteUSD: number
  cacheReadUSD: number
  webSearchPerCallUSD: number
  reasoningUSD?: number
}

/**
 * Read-only projection of a registered model. Mirror of host `ModelView`
 * (types/host-capabilities.ts). Ollama reads id, providerId, surfaceId,
 * displayName, capabilities, vendorIds.
 */
export interface ModelView {
  id: string
  aliases?: ReadonlyArray<string>
  providerId: string
  surfaceId: string
  displayName: string
  knowledgeCutoff?: string
  tags?: ReadonlyArray<string>
  capabilities: Capabilities
  pricing: ModelRate
  vendorIds?: Readonly<Record<string, string>>
}

/**
 * One row of a provider's live model listing. Mirror of host `LiveModelRow`
 * (llm/provider-plugin.ts). Ollama's live-models.ts returns these.
 */
export interface LiveModelRow {
  id: string
  displayName?: string
  createdAt?: string
}

/**
 * Provider-chosen model recommendation for an abstract sub-agent role. Mirror
 * of host `SubagentModelRecommendation` (types/plugin.ts).
 */
export interface SubagentModelRecommendation {
  role: string
  modelId: string
  effort?: string
  thinking?: boolean
}

/**
 * Result of a provider's request validation. Mirror of host
 * `ProviderValidationResult` (llm/provider-plugin.ts). References the vendored
 * runtime types so `degrade`/`errors` stay wire-compatible.
 */
export interface ProviderValidationResult {
  ok: boolean
  errors: import("./errors.ts").CapabilityViolation[]
  degrade?: import("./canonical-request.ts").CanonicalRequest
}

// ---------------------------------------------------------------------------
// Host-registry aliases for the OpenAI provider's src/ type names.
// These map the host's internal type names (used by the provider's code) onto
// the provider-neutral vendored contract types, so the plugin keeps its
// original signatures without importing src/. Source of truth: src/llm/{
// pricing.ts (MTokRate), model-registry.ts (ModelEntry), provider.ts
// (ProviderAdapter/SurfaceId/ValidationResult) }.
// ---------------------------------------------------------------------------

/** Host `MTokRate` — structurally identical to the vendored ModelRate. */
export type MTokRate = ModelRate

/** Host surface id — an opaque provider-defined string. */
export type SurfaceId = string

/**
 * Host `ModelEntry` — the registry entry. Structurally a superset of ModelView
 * with the provider-side estimator/pricing hooks. The provider reads id,
 * capabilities, vendorIds; the extra optional fields keep registration specs
 * type-compatible.
 */
export interface ModelEntry {
  id: string
  aliases?: ReadonlyArray<string>
  providerId: string
  surfaceId: SurfaceId
  displayName: string
  knowledgeCutoff?: string
  tags?: ReadonlyArray<string>
  capabilities: import("./capabilities.ts").Capabilities
  pricing: MTokRate
  vendorIds?: Readonly<Record<string, string>>
  estimateTokens?: import("./token-estimate.ts").TokenEstimator
  pricingForRequest?: (req: import("./canonical-request.ts").CanonicalRequest) => MTokRate
}

/** Host `ValidationResult` — identical to the vendored ProviderValidationResult. */
export type ValidationResult = ProviderValidationResult

// ---------------------------------------------------------------------------
// Preflight (mirror of core src/llm/provider.ts) — Anthropic surfaces the
// thinking-model-mismatch issue, so the adapter implements preflight/applyResolution.
// ---------------------------------------------------------------------------

/** One mutually-exclusive resolution choice for a {@link PreflightIssue}. */
export interface PreflightOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
  destructive?: boolean
}

/** One pre-dispatch issue that needs user resolution. */
export interface PreflightIssue {
  code: string
  title: string
  detail: string
  options: PreflightOption[]
}

/** Result of applying a user's resolution to a {@link PreflightIssue}. */
export type PreflightResolution =
  | {
      kind: "modify-request"
      request: import("./canonical-request.ts").CanonicalRequest
      adoptModelId?: string
    }
  | { kind: "cancel" }

/**
 * Media byte/format/dimension budget a (provider, model) accepts. Mirror of
 * core `src/media/limits.ts` MediaLimits, returned by the adapter's
 * `mediaLimits(model)` hook.
 */
export interface MediaLimits {
  acceptedMimeTypes: ReadonlySet<string>
  maxBytesPerItem: number
  maxRequestBytes: number
  maxItemsPerRequest: number
  maxDimension: number | null
}

/**
 * Provider-neutral auth descriptor as the legacy Anthropic HTTP layer speaks it
 * (mirror of core `src/auth/auth.ts` AuthResult). Only the fields the plugin's
 * list-models path reads are kept.
 */
export type AuthResult =
  | { type: "oauth"; token: string; refresh?: () => Promise<{ token: string }> }
  | { type: "api-key"; token: string }

/** Host `ProviderAdapter` — the adapter interface the provider implements. */
export interface ProviderAdapter {
  id: string
  displayName: string
  surfaces: ReadonlyArray<SurfaceId>
  validate(
    req: import("./canonical-request.ts").CanonicalRequest,
    model: ModelEntry,
  ): ValidationResult
  run(
    req: import("./canonical-request.ts").CanonicalRequest,
    model: ModelEntry,
    ctx: import("./provider-auth.ts").RunContext,
  ): AsyncIterable<import("./canonical-events.ts").CanonicalEvent>
  recommendSubagentModels?(): SubagentModelRecommendation[]
  preflight?(
    req: import("./canonical-request.ts").CanonicalRequest,
    model: ModelEntry,
  ): PreflightIssue[]
  applyResolution?(
    req: import("./canonical-request.ts").CanonicalRequest,
    issueCode: string,
    optionId: string,
  ): PreflightResolution
  mediaLimits?(model: ModelEntry): MediaLimits
  listModels?(ctx: import("./provider-auth.ts").RunContext): Promise<ModelEntry[]>
}
