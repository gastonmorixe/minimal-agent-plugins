/**
 * OpenCode Go `ProviderAdapter` — a triple-surface cross-plugin-reuse example.
 *
 * OpenCode Go (opencode.ai/go) is a low-cost subscription to open-weight
 * models (plus GPT-5.6 Luna). It exposes three wire formats depending on
 * the model:
 *
 * - **OpenAI Chat Completions** (`/v1/chat/completions`) — DeepSeek, GLM,
 *   Kimi, MiMo, Hy, Grok.
 * - **Anthropic Messages** (`/v1/messages`) — MiniMax, Qwen.
 * - **OpenAI Responses** (`/v1/responses`) — GPT-5.6 Luna.
 *
 * This adapter REUSES `plugins/llm-openai`'s Chat + Responses wire layers
 * and `plugins/llm-anthropic`'s Messages wire layer (vendored under `lib/`
 * and `responses/`). Only the endpoints and auth strategy differ.
 *
 * Auth: OpenCode Console device OAuth (shared with OpenCode Zen) or an API key.
 * Requests carry the opencode identity headers (see `opencode-identity.ts`).
 *
 * @module llm/providers/opencode
 */

import { opencodeApiKeyAuth } from "./auth.ts"
import { CAPS_OPENCODE_CHAT_FALLBACK } from "./capabilities.ts"
import { buildAnthropicRequestBody, validateAnthropicRequest } from "./lib/anthropic-request.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./lib/anthropic-stream.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { classifyUpstreamError, ProviderError } from "./lib/errors.ts"
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
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import type { ModelRegistrar, ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import { parseSse } from "./lib/sse-parser.ts"
import {
  findOpencodeModelByTags,
  registerOpencodeModelInto,
  registerOpencodeModels,
} from "./models.ts"
import { OPENCODE_LOGIN_HINT, opencodeConsoleOAuthLogin } from "./oauth-login.ts"
import {
  fromOpencodeToolEvents,
  OPENCODE_VERSION_ENV,
  opencodeHeaders,
  opencodePromptCacheKey,
  opencodeSessionId,
  toOpencodeToolNames,
} from "./opencode-identity.ts"
import { PRICING_OPENCODE_GENERIC } from "./pricing.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

const OPENCODE_CHAT_URL = "https://opencode.ai/inference/go/openai/v1/chat/completions"
const OPENCODE_MESSAGES_URL = "https://opencode.ai/inference/go/anthropic/v1/messages"
const OPENCODE_RESPONSES_URL = "https://opencode.ai/inference/go/openai/v1/responses"

const PROVIDER_ID = "opencode-go"

/**
 * Quota codes that do not clear by waiting
 * (opencode `packages/ai/src/provider-error.ts:119-127`).
 */
export const GO_QUOTA_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "usage_not_included",
  "billing_error",
  "gousagelimiterror",
  "freeusagelimiterror",
  "creditlimitexceeded",
])

/** Stable machine codes on thrown {@link ProviderError}s. */
export const GO_ERROR_CODES = {
  freeTierGate: "opencode.free_tier_gate",
  upgradeRequired: "opencode.upgrade_required",
  billing: "opencode.billing",
  auth: "opencode.auth",
} as const

const AUTH_CODES: ReadonlySet<string> = new Set([
  "authentication_error",
  "permission_error",
  "permission_denied",
  "api_key_invalid",
  "api_key_expired",
  "invalid_api_key",
])

function parseUpstreamError(body: string): { type?: string; code?: string; label?: string } {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: unknown; code?: unknown; message?: unknown }
    }
    const err = parsed?.error
    if (!err || typeof err !== "object") return {}
    const message = typeof err.message === "string" ? err.message : ""
    return {
      type: typeof err.type === "string" ? err.type : undefined,
      code: typeof err.code === "string" ? err.code : undefined,
      label: /^[^:\n]+: \[([A-Za-z0-9_.-]+)\]/.exec(message)?.[1],
    }
  } catch {
    return {}
  }
}

/**
 * Build the error for a non-2xx response. 429 / 5xx / 408 carry a
 * `streamErrorType` tag so the host retry loop recovers. Billing, the
 * free-tier gate, and the version gate are terminal with a `code` and `hint`.
 */
export function taggedOpencodeHttpError(
  status: number,
  body: string,
): ProviderError & { streamErrorType?: string } {
  const upstream = parseUpstreamError(body)
  const codes = [upstream.type, upstream.code, upstream.label]
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.toLowerCase())
  const upstreamCode = upstream.type ?? upstream.code

  if (status === 402 || codes.some((c) => GO_QUOTA_CODES.has(c)))
    return new ProviderError(`OpenCode Go ${status} (billing): ${body}`, PROVIDER_ID, {
      status,
      retryable: false,
      upstreamCode: codes.find((c) => GO_QUOTA_CODES.has(c)) ?? upstreamCode,
      code: GO_ERROR_CODES.billing,
      hint: "check your OpenCode Go subscription or usage limits in OpenCode Console (https://opencode.ai)",
    })

  if (codes.includes("freetiererror"))
    return new ProviderError(
      `OpenCode Go ${status}: the client gate rejected this request. Upstream: ${body}`,
      PROVIDER_ID,
      {
        status,
        retryable: false,
        upstreamCode,
        code: GO_ERROR_CODES.freeTierGate,
        hint: `check ${OPENCODE_VERSION_ENV} and that the request has the Read tool`,
      },
    )

  if (status === 426)
    return new ProviderError(
      `OpenCode Go 426: the client version in the user agent is below the server minimum. Upstream: ${body}`,
      PROVIDER_ID,
      {
        status,
        retryable: false,
        upstreamCode,
        code: GO_ERROR_CODES.upgradeRequired,
        hint: `set ${OPENCODE_VERSION_ENV} or update opencode`,
      },
    )

  // Auth codes (opencode `provider-error.ts:267-273`). Keep status 401 so the
  // host refresh path still runs for OAuth. Untagged: never retried.
  if (status === 401 || (status === 403 && codes.some((c) => AUTH_CODES.has(c))))
    return new ProviderError(`OpenCode Go ${status} (auth): ${body}`, PROVIDER_ID, {
      status,
      retryable: false,
      upstreamCode,
      code: GO_ERROR_CODES.auth,
      hint: `${OPENCODE_LOGIN_HINT} (or replace the stored API key)`,
    })

  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new ProviderError(`OpenCode Go API ${status}: ${body}`, PROVIDER_ID, {
    status,
    retryable: streamErrorType !== undefined,
    upstreamCode,
  }) as ProviderError & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

function orgIdOf(auth: ProviderAuth): string | undefined {
  if (auth.kind === "oauth") return auth.headers?.["x-org-id"]
  if (auth.kind === "api-key") return auth.organization
  return undefined
}

function withoutOrganization(auth: ProviderAuth): ProviderAuth {
  if (auth.kind !== "api-key" || !auth.organization) return auth
  const { organization: _org, ...rest } = auth
  return rest
}

/** Messages auth: an API key in `x-api-key`, an OAuth token as `Bearer`. */
function buildMessagesHeaders(auth: ProviderAuth): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  }
  if (auth.kind === "api-key") headers["x-api-key"] = auth.key
  else if (auth.kind === "oauth") headers.authorization = `Bearer ${auth.token}`
  else Object.assign(headers, auth.headers)
  return headers
}

export const opencodeAdapter: ProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "OpenCode Go",
  surfaces: [
    "openai-chat-completions",
    "anthropic-messages",
    "openai-responses",
  ] satisfies ReadonlyArray<SurfaceId>,

  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
    if (model.surfaceId === "anthropic-messages") return validateAnthropicRequest(req, model)
    return validateOpenAIRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key)
      throw new ProviderError("OpenCode Go: missing credential", PROVIDER_ID, {
        retryable: false,
        hint: OPENCODE_LOGIN_HINT,
      })
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("opencode-go: no network client on RunContext")

    const sessionId = opencodeSessionId(req.metadata?.sessionId || ctx.sessionId)
    const cacheKey = opencodePromptCacheKey(sessionId)
    const identity = opencodeHeaders({ sessionId, orgId: orgIdOf(auth) })
    const { request: mapped, renamed } = toOpencodeToolNames({ ...req, stream: true })
    const openAIAuth = withoutOrganization(auth)

    let url: string
    let headers: Record<string, string>
    let body: Record<string, unknown>
    let label: string
    if (model.surfaceId === "openai-chat-completions") {
      url = OPENCODE_CHAT_URL
      headers = { ...buildOpenAIHeaders({ auth: openAIAuth }), ...identity }
      body = { ...buildOpenAIChatBody(mapped, model) }
      body.stream = true
      body.stream_options = { include_usage: true }
      body.prompt_cache_key = cacheKey
      label = "opencode-go.chat.completions"
    } else if (model.surfaceId === "anthropic-messages") {
      url = OPENCODE_MESSAGES_URL
      headers = { ...buildMessagesHeaders(auth), ...identity }
      body = { ...buildAnthropicRequestBody(mapped, model) }
      body.stream = true
      label = "opencode-go.messages"
    } else if (model.surfaceId === "openai-responses") {
      url = OPENCODE_RESPONSES_URL
      headers = { ...buildOpenAIHeaders({ auth: openAIAuth }), ...identity }
      body = { ...buildOpenAIResponsesBody(mapped, model) }
      body.stream = true
      body.prompt_cache_key = cacheKey
      // Go keeps store off; a dangling previous_response_id would 400.
      if (body.store !== true && body.previous_response_id !== undefined)
        delete body.previous_response_id
      label = "opencode-go.responses"
    } else {
      throw new Error(`OpenCode Go adapter: unhandled surface "${model.surfaceId}"`)
    }

    ctx.debug?.header(`POST ${url}`)
    ctx.debug?.kv("model", model.id)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const response = await networkClient.request({
      label,
      method: "POST",
      url,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok) throw taggedOpencodeHttpError(response.status, await response.text())
    if (!response.body) throw new Error("OpenCode Go API: empty response body for stream")

    let events: AsyncIterable<CanonicalEvent>
    if (model.surfaceId === "openai-chat-completions")
      events = translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
    else if (model.surfaceId === "anthropic-messages")
      events = translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
    else events = translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(response.body))
    yield* renamed ? fromOpencodeToolEvents(events) : events
  },

  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    const scout = findOpencodeModelByTags(["cheap"])
    if (scout) recs.push({ role: "scout", modelId: scout })
    const balanced = findOpencodeModelByTags(["openai-compatible"])
    const balancedPick = balanced && balanced !== scout ? balanced : undefined
    if (balancedPick) recs.push({ role: "balanced", modelId: balancedPick })
    return recs
  },
}

// The registrar captured at register(ctx) so the ad-hoc hook (no ctx) works.
let capturedModels: ModelRegistrar | undefined

/** Register the OpenCode Go adapter + catalog through the setup context. */
export function bootstrapOpencode(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerOpencodeModels(ctx.models)
  ctx.providers.register(opencodeAdapter)
}

/** Register a one-off OpenCode Go slug that is not in the built-in catalog. */
export function registerOpencodeAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerOpencodeModelInto(capturedModels, {
    id: modelId,
    providerId: "opencode-go",
    displayName: modelId,
    tags: ["opencode-go"],
    surfaceId: "openai-chat-completions",
    capabilities: CAPS_OPENCODE_CHAT_FALLBACK,
    pricing: PRICING_OPENCODE_GENERIC,
  })
}

export const opencodeProviderPlugin: ProviderPlugin = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  shortCode: "og",
  register: bootstrapOpencode,
  registerAdHocModel: registerOpencodeAdHocModel,
  apiKeyAuth: opencodeApiKeyAuth,
  oauthLogin: opencodeConsoleOAuthLogin,
  formerIds: ["opencode"],
}
