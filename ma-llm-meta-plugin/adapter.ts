/**
 * Meta Model API `ProviderAdapter` — OpenAI Chat Completions against api.meta.ai.
 *
 * Reuses the shared OpenAI wire layer (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, …). Auth is API key only (no OAuth in v1).
 *
 * @module llm/providers/meta/adapter
 */

import { metaApiKeyAuth } from "./auth.ts"
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
} from "./wire-constants.ts"

/** Meta Model API adapter. OpenAI Chat Completions on api.meta.ai. */
export const metaAdapter: ProviderAdapter = {
  id: "meta",
  displayName: "Meta (Model API)",
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
        `Meta adapter: missing api-key (run \`minimal-agent provider meta login\` or set MODEL_API_KEY from ${META_DEV_CONSOLE_URL})`,
      )
    }
    if (auth.kind !== "api-key" && auth.kind !== "custom") {
      throw new Error(
        "Meta adapter: only API-key auth is supported in v1 (no OAuth). Mint a key at " +
          META_DEV_CONSOLE_URL,
      )
    }

    const headers = buildOpenAIHeaders({ auth, userAgent: META_USER_AGENT })
    Object.assign(headers, META_DEFAULT_HEADERS)

    const body = buildOpenAIChatBody(req, model) as unknown as Record<string, unknown>

    ctx.debug?.header(`POST ${CHAT_COMPLETIONS_URL}`)
    ctx.debug?.kv("model", String(body.model ?? model.id))
    ctx.debug?.kv("provider", "meta")
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("meta: no network client on RunContext")
    const response = await networkClient.request({
      label: "meta.chat.completions",
      method: "POST",
      url: CHAT_COMPLETIONS_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedHttpError("Meta Model API", response.status, text)
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
  listLiveModels: listMetaLiveModels,
  fetchSessionInfo: fetchMetaSessionInfo,
  primeSessionInfo: primeMetaSessionInfo,
  modelVersionToken(modelId: string): string | undefined {
    // muse-spark-1.2 → 1.2 ; muse-spark-1.2-contributor → 1.2-contributor
    const m = /^muse-spark-(.+)$/.exec(modelId)
    return m?.[1]
  },
}
