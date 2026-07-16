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

import { openRouterApiKeyAuth } from "./auth.ts"
import { type CanonicalEvent, isEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { classifyUpstreamError } from "./lib/errors.ts"
import type {
  ModelEntry,
  ProviderAdapter,
  SubagentModelRecommendation,
  SurfaceId,
  ValidationResult,
} from "./lib/host-types.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "./lib/openai-chat.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import type { ModelRegistrar, ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import { parseSse } from "./lib/sse-parser.ts"
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
      throw taggedHttpError("OpenRouter API", response.status, text)
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
 * Build a tagged HTTP error so the provider-neutral retry coordinator can
 * recover from a pre-stream rejection (429 rate limit, 5xx overload, 503
 * capacity shedding, …) instead of stopping the agent.
 *
 * The `streamErrorType` property is what `src/llm/run.ts` checks to decide
 * whether to retry. Without it, every non-2xx from OpenRouter is fatal.
 */
function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseOpenRouterErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`${label} ${status}: ${body}`) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
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
  // scout → first `cheap` tag, else deepseek-v4-flash, else first id.
  catalogScoutId =
    findOpenRouterModelByTags(["cheap"]) ??
    ids.find((id) => id === "deepseek/deepseek-v4-flash") ??
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
