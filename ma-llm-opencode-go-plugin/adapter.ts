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

import {
  type AnthropicStreamEvent,
  translateAnthropicStream,
} from "@minimal-agent/core/plugin-api/llm/anthropic-stream"
import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
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
import { CAPS_OPENCODE_CHAT_FALLBACK } from "./capabilities.ts"
import { opencodeMediaLimits } from "./input-formats.ts"
import { buildAnthropicRequestBody, validateAnthropicRequest } from "./lib/anthropic-request.ts"
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
 * `accept-encoding` pinned on the streaming request path.
 *
 * gzip only: gzip decompresses incrementally under Bun `fetch`, while br and
 * zstd buffer the entire body and would stall token delivery. See
 * `reports/04-compression.md` for the measurement.
 */
export const STREAM_ACCEPT_ENCODING = "gzip"

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
  headers?: { get(name: string): string | null } | null,
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
  // host refresh path still runs for OAuth. Untagged: never retried on backoff.
  if (status === 401 || (status === 403 && codes.some((c) => AUTH_CODES.has(c))))
    return new ProviderError(`OpenCode Go ${status} (auth): ${body}`, PROVIDER_ID, {
      status,
      retryable: false,
      upstreamCode,
      // The loop refreshes the credential once, then pauses for the host.
      errorClass: "recoverable",
      recovery: "refresh_credential",
      code: GO_ERROR_CODES.auth,
      hint: `${OPENCODE_LOGIN_HINT} (or replace the stored API key)`,
    })

  const c = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
    retryAfter: headers?.get("retry-after") ?? null,
  })
  const err = new ProviderError(`OpenCode Go API ${status}: ${body}`, PROVIDER_ID, {
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

export const opencodeAdapter: ProviderAdapter &
  Required<Pick<ProviderAdapterView, "recommendUtilityModel">> = {
  id: PROVIDER_ID,
  displayName: "OpenCode Go",
  surfaces: [
    "openai-chat-completions",
    "anthropic-messages",
    "openai-responses",
  ] satisfies ReadonlyArray<SurfaceId>,

  /**
   * Session title profile. DeepSeek V4.1 Flash (the 2026-10-17 release) on
   * Chat Completions. The live Go catalog
   * (https://opencode.ai/zen/go/v1/models, 2026-11-27) gives
   * `structured_output: true` and the effort list low, high, max (no off).
   * So `effort` is `low`, the lowest level. `run()` always streams, so
   * `stream` is `required`.
   */
  recommendUtilityModel() {
    return {
      modelId: "deepseek-v4.1-flash",
      structured: "json_schema",
      effort: "low",
      stream: "required",
    }
  },

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
      // The gateway takes `video_url` on Chat (OpenCode docs); PDF goes as
      // `file`, audio as `input_audio`, everything else as a placeholder.
      body = { ...buildOpenAIChatBody(mapped, model, undefined, { video: true }) }
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

    // Pin the stream encoding instead of inheriting the transport default.
    //
    // Bun's `fetch` advertises `gzip, deflate, br, zstd` and node:http2
    // advertises nothing at all, so the effective encoding is a per-transport
    // accident. Measurement (research/2026-11-13-opencode-wire-transport/
    // reports/04-compression.md) showed Bun decompresses gzip *incrementally*
    // but buffers the whole body for br and zstd (first byte 401 ms vs 103 ms
    // on a 600 ms stream). On a token stream that turns incremental delivery
    // into one long stall, so pin gzip: it keeps the bandwidth win, excludes
    // br/zstd by construction, and stops depending on a Bun default that is
    // not part of our API surface. `identity` buys nothing (the edge is
    // gzip-only and gzip streams for free).
    headers["accept-encoding"] = STREAM_ACCEPT_ENCODING

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
    if (!response.ok) {
      throw taggedOpencodeHttpError(response.status, await response.text(), response.headers)
    }
    if (!response.body) throw new Error("OpenCode Go API: empty response body for stream")

    // Hand the parser the response encoding so it can inflate a body a
    // transport left compressed (node:http2) or reject one it cannot decode,
    // instead of silently yielding zero events.
    const contentEncoding = response.headers.get("content-encoding")

    let events: AsyncIterable<CanonicalEvent>
    if (model.surfaceId === "openai-chat-completions")
      events = translateOpenAIChatStream(
        parseSse<OpenAIChatChunk>(response.body, { contentEncoding }),
      )
    else if (model.surfaceId === "anthropic-messages")
      events = translateAnthropicStream(
        parseSse<AnthropicStreamEvent>(response.body, { contentEncoding }),
      )
    else
      events = translateOpenAIResponsesStream(
        parseSse<OpenAIResponsesEvent>(response.body, { contentEncoding }),
      )
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
