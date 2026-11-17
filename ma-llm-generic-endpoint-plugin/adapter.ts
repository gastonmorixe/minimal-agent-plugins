/**
 * Generic endpoint provider adapter.
 *
 * This provider has no built-in wire format. It reads the selected runtime
 * surface from MINIMAL_AGENT_FORMAT, looks up a registered SurfaceCodec, and
 * delegates request construction + stream translation to that codec.
 *
 * @module llm/providers/generic-endpoint/adapter
 */

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import {
  defaultCapabilities,
  type EffortSupport,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import {
  classifyUpstreamError,
  type ErrorClassFields,
  parseRetryAfterMs,
  tagUpstreamError,
} from "@minimal-agent/core/plugin-api/llm/errors"
import type { RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  MediaLimits,
  ModelRegistrar,
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type {
  SurfaceCodec,
  SurfaceCodecRegistry,
} from "@minimal-agent/core/plugin-api/llm/surface-codec"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import { normalizeEndpoint, readGenericEndpointConfig } from "./config.ts"
import { genericImageOnlyCaps, genericMediaLimits } from "./input-formats.ts"
import type { ModelEntry, ProviderAdapter, ValidationResult } from "./lib/host-types.ts"
import { PRICING_GENERIC_ENDPOINT } from "./pricing.ts"

const PROVIDER_ID = "generic-endpoint"

let capturedModels: ModelRegistrar | undefined
let capturedCodecs: SurfaceCodecRegistry | undefined

function codecList(): string {
  const ids = capturedCodecs?.list().map((c) => c.surfaceId) ?? []
  return ids.length > 0 ? ids.sort().join(", ") : "none"
}

function selectedCodec(): SurfaceCodec {
  const { format } = readGenericEndpointConfig()
  const codec = capturedCodecs?.find(format)
  if (!codec) {
    throw new Error(
      `generic-endpoint: unknown format "${format}". Registered generic formats: ${codecList()}`,
    )
  }
  return codec
}

function selectedEndpoint(codec: SurfaceCodec): string {
  const { endpoint } = readGenericEndpointConfig()
  return codec.normalizeEndpoint
    ? codec.normalizeEndpoint(endpoint, codec.defaultPath)
    : normalizeEndpoint(endpoint, codec.defaultPath)
}

export const genericEndpointAdapter: ProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Generic Endpoint",
  surfaces: ["generic-endpoint"],

  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
    return selectedCodec().validate(req, model)
  },

  /** Images only, when the model has image input (see `input-formats.ts`). */
  mediaLimits(model: ModelEntry): MediaLimits {
    return genericMediaLimits(model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const codec = selectedCodec()
    const endpoint = selectedEndpoint(codec)
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("generic-endpoint: missing ctx.networkClient")

    const request = codec.buildRequest({ req, model, auth: ctx.auth, endpoint, ctx })
    ctx.debug?.header(`${request.method} ${request.url}`)
    ctx.debug?.kv("provider", PROVIDER_ID)
    ctx.debug?.kv("surface", codec.surfaceId)
    ctx.debug?.kv("model", model.vendorIds?.firstParty ?? req.modelId)
    ctx.debug?.headers(request.headers ?? {})
    if (request.body) ctx.debug?.body(request.body)

    const response = await networkClient.request(request)
    if (!response.ok) {
      const text = await response.text()
      // The codec maps its wire errors to a class; without a codec mapping
      // the status alone classifies. Retry-After is read here because the
      // codec only sees the status and the body.
      const err: Error & ErrorClassFields =
        codec.classifyError?.(response.status, text) ??
        tagUpstreamError(
          new Error(`Generic endpoint ${response.status}: ${text}`),
          classifyUpstreamError({ httpStatus: response.status }),
        )
      const retryAfterMs = parseRetryAfterMs(response.headers?.get("retry-after"))
      if (retryAfterMs !== undefined && err.retryAfterMs === undefined) {
        err.retryAfterMs = retryAfterMs
      }
      throw err
    }
    codec.onResponseHeaders?.(response.headers)
    if (!response.body) throw new Error("generic-endpoint: empty response body")
    yield* codec.translateStream({ body: response.body, response, req, model, ctx })
  },
}

/**
 * Register an ad-hoc model id for the generic endpoint using the selected
 * codec's default capabilities, tags, and pricing.
 *
 * When the user declares an effort ladder (`--effort-levels`), it is advertised
 * so startup effort validation accepts `--effort <level>`; effort is otherwise
 * pass-through and validated by the server.
 */
export function registerGenericEndpointAdHocModel(modelId: string): void {
  if (!capturedModels) return
  const codec = selectedCodec()
  const { providerModel, effortLevels, imageInput } = readGenericEndpointConfig()
  // Images only (no PDF, audio or video): the user's server formats are not
  // known. The codec image flag or the user config turns images on.
  const baseCaps = genericImageOnlyCaps(
    codec.defaultCapabilities ?? defaultCapabilities(),
    imageInput,
  )
  // When the user declares an effort ladder (--effort-levels), advertise it so
  // startup effort validation accepts `--effort <level>`. The codec defaults
  // (e.g. GPT-4o chat) declare none, which otherwise rejects any effort.
  const capabilities =
    effortLevels && effortLevels.length > 0
      ? {
          ...baseCaps,
          // Effort is pass-through (the server validates the level), so accept
          // any user-declared ladder. Cast to the host's EffortLevel union: the
          // strings ride straight onto the wire, unvalidated by the client.
          effort: {
            levels: effortLevels as EffortSupport["levels"],
            default: effortLevels[effortLevels.length - 1] as EffortSupport["default"],
          },
        }
      : baseCaps
  capturedModels.register({
    id: modelId,
    providerId: PROVIDER_ID,
    surfaceId: codec.surfaceId,
    displayName: modelId,
    tags: codec.defaultTags ?? ["generic-endpoint", codec.surfaceId],
    capabilities,
    pricing: codec.defaultPricing ?? PRICING_GENERIC_ENDPOINT,
    ...(codec.estimateTokens ? { estimateTokens: codec.estimateTokens } : {}),
    vendorIds: { firstParty: providerModel ?? modelId },
  })
}

/**
 * Wire the generic-endpoint provider into the host at startup.
 *
 * Captures the model and surface-codec registries from the setup context and
 * registers the provider adapter. A no-op when the context lacks either registry.
 */
export function bootstrapGenericEndpoint(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  capturedCodecs = ctx.surfaceCodecs
  ctx.providers.register(genericEndpointAdapter)
}

export const genericEndpointProviderPlugin: ProviderPlugin = {
  id: PROVIDER_ID,
  displayName: "Generic Endpoint",
  shortCode: "gen",
  register: bootstrapGenericEndpoint,
  registerAdHocModel: registerGenericEndpointAdHocModel,
}
