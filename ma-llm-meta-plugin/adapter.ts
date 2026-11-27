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

import { type CanonicalEvent, isEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
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
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { metaApiKeyAuth, museOAuthLogin } from "./auth.ts"
import { metaMediaLimits } from "./input-formats.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type {
  ModelEntry,
  ProviderAdapter,
  SubagentModelRecommendation,
  SurfaceId,
  ValidationResult,
} from "./lib/host-types.ts"
import type {
  ModelRegistrar,
  ProviderAdapterView,
  ProviderPlugin,
  ProviderSetupContext,
} from "./lib/provider-plugin.ts"
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
export const metaAdapter: ProviderAdapter &
  Required<Pick<ProviderAdapterView, "recommendUtilityModel">> = {
  id: "meta",
  displayName: "Meta (Model API)",
  surfaces: ["openai-chat-completions", "openai-responses"] satisfies ReadonlyArray<SurfaceId>,

  /**
   * Session title profile. Muse Ember 1.0 is the small, cheap Muse model
   * ($0.10 in / $0.50 out per 1M tokens) and takes JSON-schema output on
   * Responses. One profile serves both credentials: a Muse Code OAuth login
   * keeps a minted Model API key and sends it as an api-key, the same as a
   * Model API key (`readMuseOAuthAuth`). Effort `low` is required: with no
   * effort, Ember reasons at `max`. The Muse effort list has no `none` (see
   * `capabilities.ts`), so there is no `thinkingOff`. `run()` reads only a
   * stream, so `stream` is `required`.
   */
  recommendUtilityModel() {
    return {
      modelId: "muse-ember-1.0",
      structured: "json_schema",
      effort: "low",
      stream: "required",
    }
  },

  validate(req, model): ValidationResult {
    return validateOpenAIRequest(req, model)
  },

  /** The model's input formats (`inputMimeTypes`), 50 MB inline (Meta docs). */
  mediaLimits(model: ModelEntry) {
    return metaMediaLimits(model)
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
      // Meta Chat takes `video_url` (mp4); PDF goes as `file`, audio as `input_audio`.
      const body = buildOpenAIChatBody(req, model, undefined, { video: true })
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
        throw taggedHttpError(
          "Meta Model API",
          response.status,
          await response.text(),
          response.headers,
        )
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
      // Live 881e40c3 net-dbg showed key ABSENT on every Responses body when
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
        throw taggedHttpError(
          "Meta Responses API",
          response.status,
          await response.text(),
          response.headers,
        )
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
  const upstreamCode = parseMetaErrorCode(body)
  // Status, error code, and Retry-After become the error class the loop reads.
  const c = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
    retryAfter: headers?.get("retry-after") ?? null,
  })

  let message = `${label} ${status}: ${body}`
  const lower = body.toLowerCase()
  if (status === 402 || lower.includes("payment method") || lower.includes("billing")) {
    message = `Meta Model API: billing required. Add a payment method at ${META_DEV_CONSOLE_URL}\n${body}`
  } else if (status === 401 || lower.includes("invalid_api_key")) {
    message = `Meta Model API: invalid API key. Mint one at ${META_DEV_CONSOLE_URL}\n${body}`
  }

  return tagUpstreamError(new Error(message), c)
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
