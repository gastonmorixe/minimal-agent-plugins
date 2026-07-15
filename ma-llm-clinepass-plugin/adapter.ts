/**
 * ClinePass `ProviderAdapter` — OpenAI Chat Completions against api.cline.bot.
 *
 * Reuses the shared OpenAI wire layer (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, …). Auth is API key or OAuth bearer from the
 * provider auth store. Model IDs are full `cline-pass/...` slugs.
 *
 * @module llm/providers/clinepass/adapter
 */

import { clinepassApiKeyAuth } from "./auth.ts"
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
      throw taggedHttpError("ClinePass API", response.status, text)
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

function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseClineErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })

  let message = `${label} ${status}: ${body}`
  if (isClineNotSubscribedBody(body)) {
    message = `ClinePass: no active subscription. Subscribe at ${CLINEPASS_SUBSCRIBE_URL}\n${body}`
  } else if (isClinePassLimitBody(body)) {
    message = `ClinePass limit reached. Check usage at ${CLINEPASS_SUBSCRIBE_URL}\n${body}`
  }

  const err = new Error(message) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
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
