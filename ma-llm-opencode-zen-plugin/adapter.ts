/** OpenCode Zen adapter with Chat, Responses, and Anthropic Messages routing. */

import {
  type AnthropicStreamEvent,
  translateAnthropicStream,
} from "@minimal-agent/core/plugin-api/llm/anthropic-stream"
import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import { classifyUpstreamError, ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "@minimal-agent/core/plugin-api/llm/openai-chat"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { opencodeApiKeyAuth } from "./auth.ts"
import { opencodeMediaLimits } from "./input-formats.ts"
import { buildAnthropicRequestBody, validateAnthropicRequest } from "./lib/anthropic-request.ts"
import type { ModelEntry, ProviderAdapter, SurfaceId, ValidationResult } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import {
  registerOpencodeZenModelInto,
  registerOpencodeZenModels,
  ZEN_UNKNOWN_PAID_TAG,
} from "./models.ts"
import { OPENCODE_LOGIN_HINT, opencodeConsoleOAuthLogin } from "./oauth-login.ts"
import {
  fromOpencodeToolEvents,
  hasReadTool,
  OPENCODE_VERSION_ENV,
  opencodeHeaders,
  opencodePromptCacheKey,
  opencodeSessionId,
  toOpencodeToolNames,
} from "./opencode-identity.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

const PROVIDER_ID = "opencode-zen"

export const OPENCODE_ZEN_CHAT_URL = "https://opencode.ai/inference/openai/v1/chat/completions"
export const OPENCODE_ZEN_RESPONSES_URL = "https://opencode.ai/inference/openai/v1/responses"
export const OPENCODE_ZEN_MESSAGES_URL = "https://opencode.ai/inference/anthropic/v1/messages"

/**
 * Anonymous key. With no stored credential the gateway accepts `public` for
 * zero-cost models only (opencode `plugin/provider/opencode.ts:347-372`).
 */
export const ZEN_PUBLIC_KEY = "public"

/**
 * Quota codes that do not clear by waiting
 * (opencode `packages/ai/src/provider-error.ts:119-127`).
 */
export const ZEN_QUOTA_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "usage_not_included",
  "billing_error",
  "gousagelimiterror",
  "freeusagelimiterror",
  "creditlimitexceeded",
])

/** Stable machine codes on thrown {@link ProviderError}s. */
export const ZEN_ERROR_CODES = {
  loginRequired: "opencode.login_required",
  freeTierGate: "opencode.free_tier_gate",
  upgradeRequired: "opencode.upgrade_required",
  billing: "opencode.billing",
  auth: "opencode.auth",
} as const

/** Anonymous runtime auth, used by the host when no credential is stored. */
export function opencodeZenAnonymousAuth(): ProviderAuth {
  return { kind: "api-key", key: ZEN_PUBLIC_KEY }
}

/** True when the model has a paid input rate. */
export function isPaidModel(model: ModelEntry): boolean {
  return model.pricing.inputUSD > 0 || (model.tags ?? []).includes(ZEN_UNKNOWN_PAID_TAG)
}

function isAnonymous(auth: ProviderAuth): boolean {
  return auth.kind === "api-key" && (auth.key === ZEN_PUBLIC_KEY || auth.key === "")
}

/** Normalize an empty api key to the public key. */
function normalizeAuth(auth: ProviderAuth): ProviderAuth {
  return auth.kind === "api-key" && auth.key === "" ? { ...auth, key: ZEN_PUBLIC_KEY } : auth
}

/** Org id from the credential: OAuth `x-org-id` header, or api-key organization. */
function orgIdOf(auth: ProviderAuth): string | undefined {
  if (auth.kind === "oauth") return auth.headers?.["x-org-id"]
  if (auth.kind === "api-key") return auth.organization
  return undefined
}

/** Zen reads the org from `x-org-id`, not the OpenAI organization header. */
function withoutOrganization(auth: ProviderAuth): ProviderAuth {
  if (auth.kind !== "api-key" || !auth.organization) return auth
  const { organization: _org, ...rest } = auth
  return rest
}

/**
 * Messages route auth, as the official client sends it: an API key (and the
 * `public` key) goes in `x-api-key`, an OAuth token goes as `Bearer`
 * (opencode `packages/ai/src/providers/anthropic.ts:32-37,65`).
 */
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

/**
 * Parse an upstream error code out of a non-2xx JSON body. Zen returns
 * `{"error":{"type":"...","message":"..."}}` or `{"error":{"code":"..."}}`.
 * A quota code may also hide in a `[code]` label at the start of the message
 * (opencode `provider-error.ts:161-163`).
 */
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

/** Per-request facts that sharpen error hints. */
export interface ZenErrorContext {
  /** The request declared a `Read` (wire `read`) tool. */
  hasReadTool?: boolean
  /** The request used the anonymous `public` key. */
  anonymous?: boolean
}

function freeTierHint(ctx: ZenErrorContext): string {
  if (ctx.hasReadTool === false)
    return `this request has no Read tool, which the free tier requires; use a request with the Read tool, or ${OPENCODE_LOGIN_HINT}`
  if (ctx.anonymous)
    return `${OPENCODE_LOGIN_HINT} (or set ${OPENCODE_VERSION_ENV} if opencode updated)`
  return `check ${OPENCODE_VERSION_ENV} and that the request has the Read tool`
}

/**
 * Build the error for a non-2xx response. Retryable failures (429 / 5xx /
 * 408) carry a `streamErrorType` tag so the host retry loop recovers. Billing,
 * the free-tier gate, and the version gate are terminal and carry a `code`
 * and a `hint`.
 */
export function taggedHttpError(
  status: number,
  body: string,
  ctx: ZenErrorContext = {},
  headers?: { get(name: string): string | null } | null,
): ProviderError & { streamErrorType?: string } {
  const upstream = parseUpstreamError(body)
  const codes = [upstream.type, upstream.code, upstream.label]
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.toLowerCase())
  const upstreamCode = upstream.type ?? upstream.code
  const isQuota = status === 402 || codes.some((c) => ZEN_QUOTA_CODES.has(c))

  if (isQuota)
    return new ProviderError(`OpenCode Zen ${status} (billing): ${body}`, PROVIDER_ID, {
      status,
      retryable: false,
      upstreamCode: codes.find((c) => ZEN_QUOTA_CODES.has(c)) ?? upstreamCode,
      code: ZEN_ERROR_CODES.billing,
      hint: ctx.anonymous
        ? `the anonymous free tier limit is reached; ${OPENCODE_LOGIN_HINT} to keep going`
        : "add funds or check usage limits in OpenCode Console (https://opencode.ai)",
    })

  if (codes.includes("freetiererror"))
    return new ProviderError(
      `OpenCode Zen ${status}: the free-tier gate rejected this request. Upstream: ${body}`,
      PROVIDER_ID,
      {
        status,
        retryable: false,
        upstreamCode,
        code: ZEN_ERROR_CODES.freeTierGate,
        hint: freeTierHint(ctx),
      },
    )

  if (status === 426)
    return new ProviderError(
      `OpenCode Zen 426: the client version in the user agent is below the server minimum. Upstream: ${body}`,
      PROVIDER_ID,
      {
        status,
        retryable: false,
        upstreamCode,
        code: ZEN_ERROR_CODES.upgradeRequired,
        hint: `set ${OPENCODE_VERSION_ENV} or update opencode`,
      },
    )

  // Auth codes (opencode `provider-error.ts:267-273`). Keep status 401 so the
  // host refresh path still runs for OAuth. Untagged: never retried on backoff.
  if (status === 401 || (status === 403 && codes.some((c) => AUTH_CODES.has(c))))
    return new ProviderError(`OpenCode Zen ${status} (auth): ${body}`, PROVIDER_ID, {
      status,
      retryable: false,
      upstreamCode,
      // The loop refreshes the credential once, then pauses for the host.
      errorClass: "recoverable",
      recovery: "refresh_credential",
      code: ZEN_ERROR_CODES.auth,
      hint: `${OPENCODE_LOGIN_HINT} (or replace the stored API key)`,
    })

  const c = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
    retryAfter: headers?.get("retry-after") ?? null,
  })
  const err = new ProviderError(`OpenCode Zen API ${status}: ${body}`, PROVIDER_ID, {
    status,
    retryable: c.streamErrorType !== undefined,
    upstreamCode,
    errorClass: c.errorClass,
    ...(c.recovery ? { recovery: c.recovery } : {}),
    ...(c.retryAfterMs !== undefined ? { retryAfterMs: c.retryAfterMs } : {}),
  }) as ProviderError & { streamErrorType?: string }
  if (c.streamErrorType) err.streamErrorType = c.streamErrorType
  return err
}

function loginRequiredError(model: ModelEntry): ProviderError {
  return new ProviderError(
    `OpenCode Zen: ${model.id} is a paid model and needs an OpenCode Console login or API key`,
    PROVIDER_ID,
    { retryable: false, code: ZEN_ERROR_CODES.loginRequired, hint: OPENCODE_LOGIN_HINT },
  )
}

export const opencodeZenAdapter: ProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "OpenCode Zen",
  surfaces: [
    "openai-chat-completions",
    "anthropic-messages",
    "openai-responses",
  ] satisfies ReadonlyArray<SurfaceId>,
  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
    if (model.surfaceId === "anthropic-messages") return validateAnthropicRequest(req, model)
    return validateOpenAIRequest(req, model)
  },

  /** The model's input formats (`inputMimeTypes`, from the live catalog). */
  mediaLimits(model: ModelEntry) {
    return opencodeMediaLimits(model)
  },
  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = normalizeAuth(ctx.auth)
    const anonymous = isAnonymous(auth)
    if (anonymous && isPaidModel(model)) throw loginRequiredError(model)
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("opencode-zen: no network client on RunContext")

    // One `ses_` id per minimal-agent session: affinity headers and the
    // prompt cache key stay stable across turns.
    const sessionId = opencodeSessionId(req.metadata?.sessionId || ctx.sessionId)
    const cacheKey = opencodePromptCacheKey(sessionId)
    const identity = opencodeHeaders({ sessionId, orgId: orgIdOf(auth) })
    const { request: mapped, renamed } = toOpencodeToolNames({ ...req, stream: true })
    const errorCtx: ZenErrorContext = { hasReadTool: hasReadTool(mapped), anonymous }
    const openAIAuth = withoutOrganization(auth)

    let url: string
    let headers: Record<string, string>
    let body: Record<string, unknown>
    let label: string
    if (model.surfaceId === "openai-chat-completions") {
      url = OPENCODE_ZEN_CHAT_URL
      headers = { ...buildOpenAIHeaders({ auth: openAIAuth }), ...identity }
      // The gateway takes `video_url` on Chat (OpenCode docs); PDF goes as
      // `file`, audio as `input_audio`, everything else as a placeholder.
      body = { ...buildOpenAIChatBody(mapped, model, undefined, { video: true }) }
      body.stream = true
      body.stream_options = { include_usage: true }
      body.prompt_cache_key = cacheKey
      label = "opencode-zen.chat.completions"
    } else if (model.surfaceId === "anthropic-messages") {
      url = OPENCODE_ZEN_MESSAGES_URL
      headers = { ...buildMessagesHeaders(auth), ...identity }
      // No metadata session id here: it would add a claude-code style
      // `metadata.user_id` the opencode client never sends.
      body = { ...buildAnthropicRequestBody(mapped, model) }
      body.stream = true
      label = "opencode-zen.messages"
    } else if (model.surfaceId === "openai-responses") {
      url = OPENCODE_ZEN_RESPONSES_URL
      headers = { ...buildOpenAIHeaders({ auth: openAIAuth }), ...identity }
      body = { ...buildOpenAIResponsesBody(mapped, model) }
      body.stream = true
      body.prompt_cache_key = cacheKey
      // Zen keeps store off; a dangling previous_response_id would 400.
      if (body.store !== true && body.previous_response_id !== undefined)
        delete body.previous_response_id
      label = "opencode-zen.responses"
    } else {
      throw new Error(
        `OpenCode Zen adapter: unsupported surface ${model.surfaceId} for ${model.id}`,
      )
    }

    const response = await networkClient.request({
      label,
      method: "POST",
      url,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok) {
      throw taggedHttpError(response.status, await response.text(), errorCtx, response.headers)
    }
    if (!response.body) throw new Error("OpenCode Zen API: empty response body for stream")

    let events: AsyncIterable<CanonicalEvent>
    if (model.surfaceId === "openai-chat-completions")
      events = translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
    else if (model.surfaceId === "anthropic-messages")
      events = translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
    else events = translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(response.body))
    yield* renamed ? fromOpencodeToolEvents(events) : events
  },
}

let capturedModels: ModelRegistrar | undefined

/** Register the OpenCode Zen adapter and complete live catalog. */
export function bootstrapOpencodeZen(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerOpencodeZenModels(ctx.models)
  ctx.providers.register(opencodeZenAdapter)
}
/** Register an ad-hoc Zen model with fallback metadata. */
export function registerOpencodeZenAdHocModel(modelId: string): void {
  if (capturedModels) registerOpencodeZenModelInto(capturedModels, modelId)
}
export const opencodeProviderPlugin: ProviderPlugin = {
  id: PROVIDER_ID,
  displayName: "OpenCode Zen",
  shortCode: "oz",
  register: bootstrapOpencodeZen,
  registerAdHocModel: registerOpencodeZenAdHocModel,
  oauthLogin: opencodeConsoleOAuthLogin,
  apiKeyAuth: opencodeApiKeyAuth,
  anonymousAuth: opencodeZenAnonymousAuth,
}
