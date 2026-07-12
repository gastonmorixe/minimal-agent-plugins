/**
 * Grok (xAI) ProviderAdapter — dual surface (Chat Completions + Responses).
 *
 * Architecture mirrors `ma-llm-openai-plugin/adapter.ts`:
 * - Dispatch on `model.surfaceId`
 * - Host injects `ctx.networkClient` + `ctx.auth`
 * - Tag HTTP errors with `streamErrorType` for retries
 * - Session rate-limit headers + usage accumulation for the footer
 *
 * Wire helpers:
 * - Chat: shared OpenAI chat layer (`lib/openai-chat.ts`)
 * - Responses: vendored OpenAI Responses body/stream translators
 *
 * Auth:
 * - api-key → https://api.x.ai
 * - oauth   → cli-chat-proxy (+ X-XAI-* headers via buildGrokHeaders / auth.baseUrl)
 *
 * @module llm/providers/grok/adapter
 */

import { grokApiKeyAuth } from "./auth.ts"
import { buildGrokHeaders } from "./headers.ts"
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
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "./lib/openai-chat.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import type { ModelRegistrar, ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { listGrokLiveModels } from "./live-models.ts"
import { findGrokModelByTags, registerGrokModel, registerGrokModels } from "./models.ts"
import { grokOAuthLogin } from "./oauth-login.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"
import {
  accumulateGrokUsage,
  fetchGrokSessionInfo,
  getGrokBillingQuota,
  primeGrokSessionInfo,
  refreshGrokBillingQuota,
  setGrokRateLimits,
} from "./session-info.ts"
import { grokChatCompletionsCodec } from "./surface-codecs.ts"
import { validateOpenAIRequest } from "./validate.ts"
import {
  CHAT_COMPLETIONS_URL,
  CLI_CHAT_COMPLETIONS_URL,
  CLI_RESPONSES_URL,
  RESPONSES_URL,
} from "./wire-constants.ts"

function resolveUrl(auth: ProviderAuth, surface: "chat" | "responses"): string {
  if (auth.kind === "oauth" && auth.baseUrl) {
    const base = auth.baseUrl.replace(/\/+$/, "")
    return surface === "chat" ? `${base}/chat/completions` : `${base}/responses`
  }
  if (auth.kind === "oauth") {
    return surface === "chat" ? CLI_CHAT_COMPLETIONS_URL : CLI_RESPONSES_URL
  }
  return surface === "chat" ? CHAT_COMPLETIONS_URL : RESPONSES_URL
}

export const grokAdapter: ProviderAdapter = {
  id: "grok",
  displayName: "Grok (xAI)",
  surfaces: ["openai-chat-completions", "openai-responses"] satisfies ReadonlyArray<SurfaceId>,

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
      throw new Error("Grok adapter: missing api-key (run: minimal-agent provider grok login)")
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("Grok adapter: missing oauth token (run: minimal-agent provider grok login)")
    }

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) {
      throw new Error("Grok adapter: missing ctx.networkClient (host must provide the client)")
    }

    const wireModelId = model.vendorIds?.firstParty ?? req.modelId
    const headers = buildGrokHeaders({ auth, modelId: wireModelId })

    if (model.surfaceId === "openai-chat-completions") {
      const body = buildOpenAIChatBody(req, model)
      body.model = wireModelId
      const url = resolveUrl(auth, "chat")
      ctx.debug?.header(`POST ${url}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("provider", "grok")
      ctx.debug?.kv("surface", "chat")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "grok.chat.completions",
        method: "POST",
        url,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!response.ok) {
        throw taggedHttpError("Grok Chat API", response.status, await response.text())
      }
      setGrokRateLimits(response.headers)
      maybeRefreshOAuthBilling(auth, networkClient)
      if (!response.body) throw new Error("Grok Chat API: empty response body for stream")
      for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
        if (isEvent(ev, "message_delta")) accumulateGrokUsage(ev.usage)
        yield ev
      }
      return
    }

    if (model.surfaceId === "openai-responses") {
      const body = buildOpenAIResponsesBody(req, model)
      body.model = wireModelId
      // Keep store false by default (no server-side history unless host opts in).
      if (body.store !== true && body.previous_response_id !== undefined) {
        delete body.previous_response_id
        ctx.debug?.kv("previous_response_id", "dropped (store!=true)")
      }
      const url = resolveUrl(auth, "responses")
      ctx.debug?.header(`POST ${url}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("provider", "grok")
      ctx.debug?.kv("surface", "responses")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "grok.responses",
        method: "POST",
        url,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!response.ok) {
        throw taggedHttpError("Grok Responses API", response.status, await response.text())
      }
      setGrokRateLimits(response.headers)
      maybeRefreshOAuthBilling(auth, networkClient)
      if (!response.body) throw new Error("Grok Responses API: empty response body for stream")
      for await (const ev of translateOpenAIResponsesStream(
        parseSse<OpenAIResponsesEvent>(response.body),
      )) {
        if (isEvent(ev, "message_delta")) accumulateGrokUsage(ev.usage)
        yield ev
      }
      return
    }

    throw new Error(`Grok adapter: model ${model.id} has unsupported surface "${model.surfaceId}"`)
  },

  recommendSubagentModels(): SubagentModelRecommendation[] {
    const byTier: Array<{ role: string; tags: string[] }> = [
      { role: "scout", tags: ["cheap", "scout"] },
      { role: "balanced", tags: ["balanced", "code"] },
      { role: "deep", tags: ["flagship", "deep"] },
    ]
    const recs: SubagentModelRecommendation[] = []
    for (const { role, tags } of byTier) {
      const modelId = findGrokModelByTags(tags)
      if (modelId) recs.push({ role, modelId })
    }
    return recs
  },
}

/**
 * Fire-and-forget monthly billing refresh for OAuth/session tokens.
 * Skips when billing is already fresh (checked inside prime path via cache
 * timestamp) or auth is not oauth. Never awaits on the hot path.
 */
function maybeRefreshOAuthBilling(auth: ProviderAuth, networkClient: NetworkClient): void {
  if (auth.kind !== "oauth" || !auth.token) return
  // Only re-fetch when we have no cached monthly window yet, or it's stale
  // enough that prime would also re-fetch (60 min). Avoids a GET per turn.
  const cached = getGrokBillingQuota()
  const BILLING_FRESHNESS_MS = 5 * 60_000 * 12
  if (cached && Date.now() - cached.at < BILLING_FRESHNESS_MS) return
  void refreshGrokBillingQuota(networkClient, auth.token).catch(() => {
    /* best-effort */
  })
}

function parseGrokErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseGrokErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`${label} ${status}: ${body}`) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

let capturedModels: ModelRegistrar | undefined

/** Register the Grok adapter, catalog, and chat surface codec with the host. */
export function bootstrapGrok(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerGrokModels(ctx.models)
  ctx.providers.register(grokAdapter)
  // Expose chat surface to generic-endpoint provider (same pattern as OpenAI).
  ctx.surfaceCodecs?.register(grokChatCompletionsCodec)
}

/** Register a one-off Grok model id that is not in the static catalog. */
export function registerGrokAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerGrokModel({ id: modelId }, capturedModels)
}

export const grokProviderPlugin: ProviderPlugin = {
  id: "grok",
  displayName: "Grok (xAI)",
  shortCode: "xai",
  register: bootstrapGrok,
  registerAdHocModel: registerGrokAdHocModel,
  apiKeyAuth: grokApiKeyAuth,
  oauthLogin: grokOAuthLogin,
  fetchSessionInfo: fetchGrokSessionInfo,
  primeSessionInfo: primeGrokSessionInfo,
  listLiveModels: listGrokLiveModels,
  modelVersionToken(modelId: string): string | undefined {
    return modelId.replace(/^grok-?/i, "").replace(/-chat$/i, "") || modelId
  },
}
