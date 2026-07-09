// source: plugin-api/src/llm/surface-codec.ts (vendored generic surface-codec contract for Wave G self-containment)
/**
 * Generic wire-surface codec contract.
 *
 * @module lib/surface-codec
 */

import type { CanonicalEvent } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { Capabilities } from "./capabilities.ts"
import type { ModelRate, ModelView, ProviderValidationResult } from "./host-types.ts"
import type { NetworkRequestInput, NetworkResponse } from "./net-types.ts"
import type { ProviderAuth, RunContext } from "./provider-auth.ts"
import type { TokenEstimator } from "./token-estimate.ts"

export interface SurfaceBuildRequestInput {
  req: CanonicalRequest
  model: ModelView
  auth: ProviderAuth
  endpoint: string
  ctx: RunContext
}

export interface SurfaceTranslateInput {
  body: ReadableStream<Uint8Array>
  response: NetworkResponse
  req: CanonicalRequest
  model: ModelView
  ctx: RunContext
}

export type SurfaceCodecError = Error & { streamErrorType?: string }

export interface SurfaceCodec {
  readonly surfaceId: string
  readonly displayName: string
  readonly defaultPath: string
  readonly defaultCapabilities: Capabilities
  readonly defaultPricing: ModelRate
  readonly defaultTags?: ReadonlyArray<string>
  readonly estimateTokens?: TokenEstimator
  normalizeEndpoint?(endpoint: string, defaultPath: string): string
  validate(req: CanonicalRequest, model: ModelView): ProviderValidationResult
  buildRequest(input: SurfaceBuildRequestInput): NetworkRequestInput
  translateStream(input: SurfaceTranslateInput): AsyncIterable<CanonicalEvent>
  classifyError?(status: number, body: string): SurfaceCodecError
  onResponseHeaders?(headers: Headers): void
}

export interface SurfaceCodecRegistry {
  register(codec: SurfaceCodec): void
  find(surfaceId: string): SurfaceCodec | undefined
  list(): SurfaceCodec[]
}
