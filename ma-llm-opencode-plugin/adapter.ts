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
 * Auth: a Bearer API key from minimal-agent's provider auth store.
 *
 * @module llm/providers/opencode
 */

import { opencodeApiKeyAuth } from "./auth.ts"
import { CAPS_OPENCODE_CHAT_FALLBACK } from "./capabilities.ts"
import { buildAnthropicRequestBody, validateAnthropicRequest } from "./lib/anthropic-request.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./lib/anthropic-stream.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
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
  findOpencodeModelByTags,
  registerOpencodeModelInto,
  registerOpencodeModels,
} from "./models.ts"
import { PRICING_OPENCODE_GENERIC } from "./pricing.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
const OPENCODE_MESSAGES_URL = "https://opencode.ai/zen/go/v1/messages"
const OPENCODE_RESPONSES_URL = "https://opencode.ai/zen/go/v1/responses"

/**
 * Parse an upstream error code out of a non-2xx JSON body. The gateway fronts
 * both Anthropic-style (`{"error":{"type":"..."}}`) and OpenAI-style
 * (`{"error":{"code":"..."}}`) surfaces; fall back to undefined for non-JSON
 * bodies so the status alone classifies.
 */
function parseOpencodeErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } }
    const err = parsed?.error
    if (err && typeof err === "object") {
      if (typeof err.type === "string") return err.type
      if (typeof err.code === "string") return err.code
    }
    return undefined
  } catch {
    return undefined
  }
}

type TaggedHttpError = Error & { streamErrorType?: string; retryable?: boolean }

/**
 * Build a tagged HTTP error so the provider-neutral retry coordinator can
 * recover from a pre-stream rejection (429 rate limit, 5xx overload) instead
 * of stopping the agent. Terminal verdicts (billing, auth) carry
 * `retryable: false` so they propagate. Untagged errors propagate.
 */
function taggedOpencodeHttpError(status: number, body: string): TaggedHttpError {
  const upstreamCode = parseOpencodeErrorCode(body)
  const { streamErrorType, retryable } = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
  })
  const err = new Error(`OpenCode Go API ${status}: ${body}`) as TaggedHttpError
  if (streamErrorType) err.streamErrorType = streamErrorType
  if (retryable === false) err.retryable = false
  return err
}

/** Product UA required by OpenCode Go (not a generic SDK / HTTP-library name). */
const OPENCODE_USER_AGENT = "minimal-agent-opencode/0.1"

function buildOpencodeMessagesHeaders(
  auth: RunContext["auth"],
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": OPENCODE_USER_AGENT,
    "x-opencode-session": sessionId,
  }
  if (auth.kind === "api-key") {
    headers["x-api-key"] = auth.key
  } else if (auth.kind === "oauth") {
    headers["authorization"] = `Bearer ${auth.token}`
  } else {
    Object.assign(headers, auth.headers)
  }
  return headers
}

export const opencodeAdapter: ProviderAdapter = {
  id: "opencode",
  displayName: "OpenCode Go",
  surfaces: [
    "openai-chat-completions",
    "anthropic-messages",
    "openai-responses",
  ] satisfies ReadonlyArray<SurfaceId>,

  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
    if (model.surfaceId === "anthropic-messages") {
      return validateAnthropicRequest(req, model)
    }
    // Chat Completions + Responses share the OpenAI capability validator.
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
        "OpenCode Go adapter: missing api-key (run `minimal-agent provider opencode login`)",
      )
    }

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("opencode: no network client on RunContext")

    if (model.surfaceId === "openai-chat-completions") {
      const headers = buildOpenAIHeaders({
        auth,
        userAgent: OPENCODE_USER_AGENT,
        sessionId: ctx.sessionId,
      })
      const body = buildOpenAIChatBody(req, model)
      const serialized = JSON.stringify(body)

      ctx.debug?.header(`POST ${OPENCODE_CHAT_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "opencode.chat.completions",
        method: "POST",
        url: OPENCODE_CHAT_URL,
        headers,
        body: serialized,
        signal: req.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw taggedOpencodeHttpError(response.status, text)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
    } else if (model.surfaceId === "anthropic-messages") {
      const headers = buildOpencodeMessagesHeaders(auth, ctx.sessionId)
      const body = buildAnthropicRequestBody(req, model)
      const serialized = JSON.stringify(body)

      ctx.debug?.header(`POST ${OPENCODE_MESSAGES_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "opencode.messages",
        method: "POST",
        url: OPENCODE_MESSAGES_URL,
        headers,
        body: serialized,
        signal: req.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw taggedOpencodeHttpError(response.status, text)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
    } else if (model.surfaceId === "openai-responses") {
      const headers = buildOpenAIHeaders({
        auth,
        userAgent: OPENCODE_USER_AGENT,
        sessionId: ctx.sessionId,
      })
      const body = buildOpenAIResponsesBody(req, model)
      if (!body.prompt_cache_key && ctx.sessionId) {
        body.prompt_cache_key = ctx.sessionId
      }
      // OpenCode Go is API-key only; keep store off unless the caller set it.
      if (body.store !== true && body.previous_response_id !== undefined) {
        delete body.previous_response_id
        ctx.debug?.kv("previous_response_id", "dropped (store!=true)")
      }
      const serialized = JSON.stringify(body)

      ctx.debug?.header(`POST ${OPENCODE_RESPONSES_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("surface", "responses")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "opencode.responses",
        method: "POST",
        url: OPENCODE_RESPONSES_URL,
        headers,
        body: serialized,
        signal: req.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw taggedOpencodeHttpError(response.status, text)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(response.body))
    } else {
      throw new Error(`OpenCode Go adapter: unhandled surface "${model.surfaceId}"`)
    }
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
    providerId: "opencode",
    displayName: modelId,
    tags: ["opencode"],
    surfaceId: "openai-chat-completions",
    capabilities: CAPS_OPENCODE_CHAT_FALLBACK,
    pricing: PRICING_OPENCODE_GENERIC,
  })
}

export const opencodeProviderPlugin: ProviderPlugin = {
  id: "opencode",
  displayName: "OpenCode Go",
  shortCode: "og",
  register: bootstrapOpencode,
  registerAdHocModel: registerOpencodeAdHocModel,
  apiKeyAuth: opencodeApiKeyAuth,
}
