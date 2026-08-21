/** OpenCode Zen adapter with Chat, Responses, and Anthropic Messages routing. */
import { opencodeApiKeyAuth } from "./auth.ts"
import { buildAnthropicRequestBody, validateAnthropicRequest } from "./lib/anthropic-request.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./lib/anthropic-stream.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry, ProviderAdapter, SurfaceId, ValidationResult } from "./lib/host-types.ts"
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
import { registerOpencodeZenModelInto, registerOpencodeZenModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

export const OPENCODE_ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions"
export const OPENCODE_ZEN_MESSAGES_URL = "https://opencode.ai/zen/v1/messages"
export const OPENCODE_ZEN_RESPONSES_URL = "https://opencode.ai/zen/v1/responses"
export const OPENCODE_ZEN_GEMINI_URL = "https://opencode.ai/zen/v1/models"

function buildMessagesHeaders(auth: RunContext["auth"]): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": "minimal-agent-opencode-zen/0.1",
  }
  if (auth.kind === "api-key") headers["x-api-key"] = auth.key
  else if (auth.kind === "oauth") headers.authorization = `Bearer ${auth.token}`
  else Object.assign(headers, auth.headers)
  return headers
}

export const opencodeZenAdapter: ProviderAdapter = {
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  surfaces: [
    "openai-chat-completions",
    "anthropic-messages",
    "openai-responses",
    "google-generative-language",
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
      throw new Error(
        "OpenCode Zen adapter: missing api-key (run `minimal-agent provider opencode-zen login)`",
      )
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("opencode-zen: no network client on RunContext")
    let url: string
    let headers: Record<string, string>
    let body: unknown
    let label: string
    if (model.surfaceId === "openai-chat-completions") {
      url = OPENCODE_ZEN_CHAT_URL
      headers = buildOpenAIHeaders({ auth, userAgent: "minimal-agent-opencode-zen/0.1" })
      body = buildOpenAIChatBody(req, model)
      label = "opencode-zen.chat.completions"
    } else if (model.surfaceId === "anthropic-messages") {
      url = OPENCODE_ZEN_MESSAGES_URL
      headers = buildMessagesHeaders(auth)
      body = buildAnthropicRequestBody(req, model)
      label = "opencode-zen.messages"
    } else if (model.surfaceId === "openai-responses") {
      url = OPENCODE_ZEN_RESPONSES_URL
      headers = buildOpenAIHeaders({ auth, userAgent: "minimal-agent-opencode-zen/0.1" })
      body = buildOpenAIResponsesBody(req, model)
      label = "opencode-zen.responses"
    } else {
      throw new Error(
        `OpenCode Zen adapter: Gemini model surface is documented but unsupported: ${model.id}`,
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
    if (!response.ok)
      throw new Error(`OpenCode Zen API ${response.status}: ${await response.text()}`)
    if (!response.body) throw new Error("OpenCode Zen API: empty response body for stream")
    if (model.surfaceId === "openai-chat-completions")
      yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
    else if (model.surfaceId === "anthropic-messages")
      yield* translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
    else yield* translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(response.body))
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
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  shortCode: "oz",
  register: bootstrapOpencodeZen,
  registerAdHocModel: registerOpencodeZenAdHocModel,
  apiKeyAuth: opencodeApiKeyAuth,
}
