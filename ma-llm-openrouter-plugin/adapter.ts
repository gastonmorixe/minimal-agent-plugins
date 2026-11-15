/**
 * OpenRouter `ProviderAdapter` — a cross-plugin-reuse example.
 *
 * OpenRouter (openrouter.ai) is an OpenAI Chat Completions-compatible
 * gateway to many upstream models, so this adapter REUSES
 * `plugins/llm-openai`'s wire layer wholesale (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, `buildOpenAIHeaders`, `validateOpenAIRequest`).
 * Only the endpoint, model catalog, auth strategy, and the optional
 * OpenRouter attribution header differ.
 *
 * Auth: a Bearer key from minimal-agent's provider auth store, passed via
 * `RunContext.auth = { kind: "api-key", key }`.
 *
 * @module llm/providers/openrouter/adapter
 */

import { type CanonicalEvent, isEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import {
  classifyUpstreamError,
  type ErrorClassFields,
  tagUpstreamError,
} from "@minimal-agent/core/plugin-api/llm/errors"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "@minimal-agent/core/plugin-api/llm/openai-chat"
import type { RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  ModelRegistrar,
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { openRouterApiKeyAuth } from "./auth.ts"
import type {
  ModelEntry,
  ProviderAdapter,
  SubagentModelRecommendation,
  SurfaceId,
  ValidationResult,
} from "./lib/host-types.ts"
import {
  findOpenRouterModelByTags,
  registerOpenRouterModelInto,
  registerOpenRouterModels,
} from "./models.ts"
import {
  accumulateOpenRouterUsage,
  fetchOpenRouterSessionInfo,
  setOpenRouterRateLimits,
} from "./session-info.ts"

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

/** OpenRouter adapter. Speaks the OpenAI Chat surface against OpenRouter's host. */
export const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  displayName: "OpenRouter",
  surfaces: ["openai-chat-completions"] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    return validateOpenAIRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error(
        "OpenRouter adapter: missing api-key (run minimal-agent provider openrouter login)",
      )
    }

    const headers = buildOpenAIHeaders({ auth })
    // Optional OpenRouter attribution header (used for their app leaderboard).
    headers["x-title"] = "minimal-agent"
    const body = buildOpenAIChatBody(req, model)
    ctx.debug?.header(`POST ${OPENROUTER_CHAT_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("openrouter: no network client on RunContext")
    const response = await networkClient.request({
      label: "openrouter.chat.completions",
      method: "POST",
      url: OPENROUTER_CHAT_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedHttpError("OpenRouter API", response.status, text, response.headers)
    }
    // Capture rate-limit headers for the status-bar footer. Best-effort +
    // non-throwing; no behavior change to the stream below.
    setOpenRouterRateLimits(response.headers)
    if (!response.body) {
      throw new Error("OpenRouter API: empty response body for stream")
    }
    // Accumulate usage from the stream's terminal message_delta event so the
    // footer displays per-session token totals and estimated cost.
    for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
      if (isEvent(ev, "message_delta")) {
        accumulateOpenRouterUsage(ev.usage)
      }
      yield ev
    }
  },

  /**
   * Recommend OpenRouter models per abstract sub-agent role, from THIS
   * provider's own (representative) catalog by tag. scout → a `cheap` model;
   * balanced → a non-cheap openai-compatible model; deep → flagship when
   * present (else the caller falls back to the lead's model).
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    if (catalogScoutId) recs.push({ role: "scout", modelId: catalogScoutId })
    // prefer a DIFFERENT model than scout for balanced when possible
    if (catalogBalancedId && catalogBalancedId !== catalogScoutId) {
      recs.push({ role: "balanced", modelId: catalogBalancedId })
    }
    if (catalogDeepId && catalogDeepId !== catalogScoutId && catalogDeepId !== catalogBalancedId) {
      recs.push({ role: "deep", modelId: catalogDeepId })
    }
    return recs
  },
}

/**
 * Parse the OpenRouter error code out of a non-2xx JSON body. OpenRouter
 * returns the standard OpenAI error shape:
 * `{"error":{"message":"…","type":"…","code":"…"}}`.
 */
function parseOpenRouterErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build the error for a non-2xx response. Status, the body error code, and
 * `Retry-After` go through `classifyUpstreamError`; the retry tag and the
 * error class (transient, recoverable, permanent) are stamped on the error,
 * so the host loop decides from the class.
 */
export function taggedHttpError(
  label: string,
  status: number,
  body: string,
  headers?: { get(name: string): string | null } | null,
): Error & ErrorClassFields & { streamErrorType?: string } {
  const upstreamCode = parseOpenRouterErrorCode(body)
  // Status, error code, and Retry-After become the error class the loop reads.
  const c = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
    retryAfter: headers?.get("retry-after") ?? null,
  })
  return tagUpstreamError(new Error(`${label} ${status}: ${body}`), c)
}

// Role picks captured at registration so `recommendSubagentModels` reads the
// provider's OWN catalog without a host registry round-trip (findModelByTags).
let catalogScoutId: string | undefined
let catalogBalancedId: string | undefined
let catalogDeepId: string | undefined
// The registrar captured at register(ctx), so the ad-hoc hook (called WITHOUT
// a ctx) can still register a live-only slug the static catalog doesn't know.
let capturedModels: ModelRegistrar | undefined

/**
 * Register the OpenRouter adapter + catalog through the setup context. The
 * catalog enters via `ctx.models`, the adapter via `ctx.providers`; the scout
 * and balanced sub-agent picks are captured here from the returned ids so
 * `recommendSubagentModels` needs no host read. A no-`ctx` call is a no-op
 * (nothing to register into).
 */
export function bootstrapOpenRouter(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  const ids = registerOpenRouterModels(ctx.models)
  // scout → first `cheap` tag, else deepseek-v4.1-flash, else first id.
  catalogScoutId =
    findOpenRouterModelByTags(["cheap"]) ??
    ids.find((id) => id === "deepseek/deepseek-v4.1-flash") ??
    ids[0]
  // balanced → first non-scout openai-compatible model (skip other cheap ones).
  catalogBalancedId =
    ids.find((id) => id !== catalogScoutId && id !== "openai/gpt-4o-mini") ??
    ids.find((id) => id !== catalogScoutId)
  catalogDeepId = findOpenRouterModelByTags(["flagship"]) ?? ids[0]
  ctx.providers.register(openrouterAdapter)
}

/** Register a one-off OpenRouter slug that is not in the built-in catalog. */
export function registerOpenRouterAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerOpenRouterModelInto(capturedModels, { id: modelId })
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const openrouterProviderPlugin: ProviderPlugin = {
  id: "openrouter",
  displayName: "OpenRouter",
  shortCode: "or",
  register: bootstrapOpenRouter,
  registerAdHocModel: registerOpenRouterAdHocModel,
  apiKeyAuth: openRouterApiKeyAuth,
  fetchSessionInfo: fetchOpenRouterSessionInfo,
}
