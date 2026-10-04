/**
 * Meta Model API `ProviderAdapter` — dual surface (Chat Completions + Responses).
 *
 * Architecture mirrors `ma-llm-openai-plugin` / `ma-llm-grok-plugin`:
 * - Dispatch on `model.surfaceId`
 * - Host injects `ctx.networkClient` + `ctx.auth`
 * - Tag HTTP errors with `streamErrorType` for retries
 * - Session rate-limit headers + usage accumulation for the footer
 *
 * Wire helpers:
 * - Chat: shared OpenAI chat layer (`lib/openai-chat.ts`)
 * - Responses: vendored OpenAI Responses body/stream translators (Meta defaults)
 *
 * Auth: API key and Muse Code OAuth (minted key as Bearer).
 *
 * @module llm/providers/meta/adapter
 */

import { metaApiKeyAuth, museOAuthLogin } from "./auth.ts"
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
import { listMetaLiveModels } from "./live-models.ts"
import { findMetaModelByTags, registerMetaModel, registerMetaModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"
import {
  accumulateMetaUsage,
  fetchMetaSessionInfo,
  primeMetaSessionInfo,
  setMetaRateLimits,
} from "./session-info.ts"
import {
  CHAT_COMPLETIONS_URL,
  META_DEFAULT_HEADERS,
  META_DEV_CONSOLE_URL,
  META_USER_AGENT,
  RESPONSES_URL,
} from "./wire-constants.ts"

/** Meta Model API adapter. Chat Completions + Responses on api.meta.ai. */
export const metaAdapter: ProviderAdapter = {
  id: "meta",
  displayName: "Meta (Model API)",
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
      throw new Error(
        `Meta adapter: missing api-key (run \`minimal-agent provider meta login api-key\` or set MODEL_API_KEY from ${META_DEV_CONSOLE_URL})`,
      )
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error(
        "Meta adapter: missing Muse Code OAuth token (run `minimal-agent provider meta login`)",
      )
    }
    if (auth.kind !== "api-key" && auth.kind !== "oauth" && auth.kind !== "custom") {
      throw new Error(
        "Meta adapter: unsupported auth kind. Use Muse Code OAuth (`provider meta login`) or an API key from " +
          META_DEV_CONSOLE_URL,
      )
    }

    const headers = buildOpenAIHeaders({ auth, userAgent: META_USER_AGENT })
    Object.assign(headers, META_DEFAULT_HEADERS)

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("meta: no network client on RunContext")

    const wireModelId = model.vendorIds?.firstParty ?? req.modelId

    if (model.surfaceId === "openai-chat-completions") {
      const body = buildOpenAIChatBody(req, model)
      body.model = wireModelId

      ctx.debug?.header(`POST ${CHAT_COMPLETIONS_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("provider", "meta")
      ctx.debug?.kv("surface", "chat")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "meta.chat.completions",
        method: "POST",
        url: CHAT_COMPLETIONS_URL,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })

      if (!response.ok) {
        throw taggedHttpError("Meta Model API", response.status, await response.text())
      }
      setMetaRateLimits(response.headers)
      if (!response.body) {
        throw new Error("Meta Model API: empty response body for stream")
      }
      for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
        if (isEvent(ev, "message_delta")) {
          accumulateMetaUsage(ev.usage)
        }
        yield ev
      }
      return
    }

    if (model.surfaceId === "openai-responses") {
      const body = buildOpenAIResponsesBody(req, model)
      body.model = wireModelId
      // Defense in depth (OpenAI adapter parity): request-body stamps
      // prompt_cache_key from vendor.promptCacheKey / metadata.sessionId.
      // Live 68a0d8fb net-dbg showed key ABSENT on every Responses body when
      // those fields are unset. Fall back to RunContext.sessionId so Meta
      // always gets sticky routing like Codex / OpenAI.
      if (!body.prompt_cache_key && ctx.sessionId) {
        body.prompt_cache_key = ctx.sessionId
        ctx.debug?.kv("prompt_cache_key", "from ctx.sessionId")
      }
      // Keep store false by default. Drop previous_response_id unless host opts into store.
      if (body.store !== true && body.previous_response_id !== undefined) {
        delete body.previous_response_id
        ctx.debug?.kv("previous_response_id", "dropped (store!=true)")
      }

      ctx.debug?.header(`POST ${RESPONSES_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("provider", "meta")
      ctx.debug?.kv("surface", "responses")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "meta.responses",
        method: "POST",
        url: RESPONSES_URL,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })

      if (!response.ok) {
        throw taggedHttpError("Meta Responses API", response.status, await response.text())
      }
      setMetaRateLimits(response.headers)
      if (!response.body) {
        throw new Error("Meta Responses API: empty response body for stream")
      }
      for await (const ev of translateOpenAIResponsesStream(
        parseSse<OpenAIResponsesEvent>(response.body),
      )) {
        if (isEvent(ev, "message_delta")) {
          accumulateMetaUsage(ev.usage)
        }
        yield ev
      }
      return
    }

    throw new Error(`Meta adapter: model ${model.id} has unsupported surface "${model.surfaceId}"`)
  },

  recommendSubagentModels(): SubagentModelRecommendation[] {
    const byTier: Array<{ role: string; tags: string[] }> = [
      { role: "scout", tags: ["cheap", "scout"] },
      { role: "balanced", tags: ["balanced"] },
      { role: "deep", tags: ["flagship", "deep"] },
    ]
    const recs: SubagentModelRecommendation[] = []
    for (const { role, tags } of byTier) {
      const modelId = findMetaModelByTags(tags)
      if (modelId) recs.push({ role, modelId })
    }
    return recs
  },
}

function parseMetaErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string; message?: string }
      message?: string
    }
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
  const upstreamCode = parseMetaErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })

  let message = `${label} ${status}: ${body}`
  const lower = body.toLowerCase()
  if (status === 402 || lower.includes("payment method") || lower.includes("billing")) {
    message = `Meta Model API: billing required. Add a payment method at ${META_DEV_CONSOLE_URL}\n${body}`
  } else if (status === 401 || lower.includes("invalid_api_key")) {
    message = `Meta Model API: invalid API key. Mint one at ${META_DEV_CONSOLE_URL}\n${body}`
  }

  const err = new Error(message) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

let capturedModels: ModelRegistrar | undefined

/** Register adapter + full model catalog. */
export function bootstrapMeta(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerMetaModels(ctx.models)
  ctx.providers.register(metaAdapter)
}

/** Register a one-off model id not in the static catalog. */
export function registerMetaAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerMetaModel({ id: modelId }, capturedModels)
}

export const metaProviderPlugin: ProviderPlugin = {
  id: "meta",
  displayName: "Meta (Model API)",
  shortCode: "meta",
  register: bootstrapMeta,
  registerAdHocModel: registerMetaAdHocModel,
  apiKeyAuth: metaApiKeyAuth,
  oauthLogin: museOAuthLogin,
  listLiveModels: listMetaLiveModels,
  fetchSessionInfo: fetchMetaSessionInfo,
  primeSessionInfo: primeMetaSessionInfo,
  modelVersionToken(modelId: string): string | undefined {
    // muse-spark-1.2 → 1.2 ; muse-spark-1.2-chat → 1.2-chat
    const m = /^muse-spark-(.+)$/.exec(modelId)
    return m?.[1]
  },
}
