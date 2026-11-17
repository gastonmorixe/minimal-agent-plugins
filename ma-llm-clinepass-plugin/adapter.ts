/**
 * ClinePass `ProviderAdapter` — OpenAI Chat Completions against api.cline.bot.
 *
 * Reuses the shared OpenAI wire layer (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, …). Auth is API key or OAuth bearer from the
 * provider auth store. Model IDs are full `cline-pass/...` slugs.
 *
 * @module llm/providers/clinepass/adapter
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
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { clinepassApiKeyAuth } from "./auth.ts"
import { clinepassMediaLimits } from "./input-formats.ts"
import type {
  ModelEntry,
  ProviderAdapter,
  SubagentModelRecommendation,
  SurfaceId,
  ValidationResult,
} from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import {
  findClinepassModelByTags,
  registerClinepassModel,
  registerClinepassModels,
} from "./models.ts"
import { clinepassOAuthLogin } from "./oauth-login.ts"
import {
  accumulateClinepassUsage,
  fetchClinepassSessionInfo,
  primeClinepassSessionInfo,
  setClinepassRateLimits,
} from "./session-info.ts"
import {
  CHAT_COMPLETIONS_URL,
  CLINEPASS_DEFAULT_HEADERS,
  CLINEPASS_SUBSCRIBE_URL,
} from "./wire-constants.ts"

/** ClinePass adapter. OpenAI Chat surface on Cline's gateway. */
export const clinepassAdapter: ProviderAdapter = {
  id: "clinepass",
  displayName: "ClinePass",
  surfaces: ["openai-chat-completions"] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    return validateOpenAIRequest(req, model)
  },

  /** Images only on vision models (`image_url`), core default sizes. */
  mediaLimits(model: ModelEntry): MediaLimits {
    return clinepassMediaLimits(model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error(
        "ClinePass adapter: missing api-key (run `provider clinepass login` or set an API key from app.cline.bot)",
      )
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("ClinePass adapter: missing OAuth access token (re-login)")
    }

    const headers = buildOpenAIHeaders({ auth })
    // Attribution + Cline tracking headers (harmless for third-party clients).
    Object.assign(headers, CLINEPASS_DEFAULT_HEADERS)
    if (auth.kind === "oauth" && auth.headers) {
      Object.assign(headers, auth.headers)
    }

    const body = buildOpenAIChatBody(req, model) as unknown as Record<string, unknown>
    // Prefer max_completion_tokens when the wire layer emitted max_tokens only
    // for Fireworks-routed open models (community clients report 400s otherwise).
    if ("max_tokens" in body && !("max_completion_tokens" in body)) {
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
    }

    ctx.debug?.header(`POST ${CHAT_COMPLETIONS_URL}`)
    ctx.debug?.kv("model", String(body.model ?? model.id))
    ctx.debug?.kv("provider", "clinepass")
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("clinepass: no network client on RunContext")
    const response = await networkClient.request({
      label: "clinepass.chat.completions",
      method: "POST",
      url: CHAT_COMPLETIONS_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedHttpError("ClinePass API", response.status, text, response.headers)
    }
    setClinepassRateLimits(response.headers)
    if (!response.body) {
      throw new Error("ClinePass API: empty response body for stream")
    }
    for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
      if (isEvent(ev, "message_delta")) {
        accumulateClinepassUsage(ev.usage)
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
      const modelId = findClinepassModelByTags(tags)
      if (modelId) recs.push({ role, modelId })
    }
    return recs
  },
}

function parseClineErrorCode(body: string): string | undefined {
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

function isClinePassLimitBody(body: string): boolean {
  const n = body.toLowerCase()
  return n.includes("you have reached your") && n.includes("clinepass limit")
}

function isClineNotSubscribedBody(body: string): boolean {
  const n = body.toLowerCase()
  return (
    n.includes("the user is not subscribed to required model plan") ||
    n.includes("no access to clinepass subscription models")
  )
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
  const upstreamCode = parseClineErrorCode(body)
  // Status, error code, and Retry-After become the error class the loop reads.
  const c = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
    retryAfter: headers?.get("retry-after") ?? null,
  })

  let message = `${label} ${status}: ${body}`
  if (isClineNotSubscribedBody(body)) {
    message = `ClinePass: no active subscription. Subscribe at ${CLINEPASS_SUBSCRIBE_URL}\n${body}`
  } else if (isClinePassLimitBody(body)) {
    message = `ClinePass limit reached. Check usage at ${CLINEPASS_SUBSCRIBE_URL}\n${body}`
  }

  return tagUpstreamError(new Error(message), c)
}

let capturedModels: ModelRegistrar | undefined

/** Register adapter + full model catalog. */
export function bootstrapClinepass(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerClinepassModels(ctx.models)
  ctx.providers.register(clinepassAdapter)
}

/** Register a one-off model id not in the static catalog. */
export function registerClinepassAdHocModel(modelId: string): void {
  if (!capturedModels) return
  // Accept bare ids by prefixing cline-pass/ when missing.
  const id = modelId.includes("/") ? modelId : `cline-pass/${modelId}`
  registerClinepassModel({ id }, capturedModels)
}

export const clinepassProviderPlugin: ProviderPlugin = {
  id: "clinepass",
  displayName: "ClinePass",
  shortCode: "cp",
  register: bootstrapClinepass,
  registerAdHocModel: registerClinepassAdHocModel,
  apiKeyAuth: clinepassApiKeyAuth,
  oauthLogin: clinepassOAuthLogin,
  fetchSessionInfo: fetchClinepassSessionInfo,
  primeSessionInfo: primeClinepassSessionInfo,
  modelVersionToken(modelId: string): string | undefined {
    const slash = modelId.lastIndexOf("/")
    return slash >= 0 ? modelId.slice(slash + 1) : modelId
  },
}
