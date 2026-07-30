/**
 * OpenCode Go `ProviderAdapter` — a dual-surface cross-plugin-reuse example.
 *
 * OpenCode Go (opencode.ai/go) is a low-cost subscription to open-weight
 * models. It exposes two wire formats depending on the model:
 *
 * - **OpenAI Chat Completions** (`/v1/chat/completions`) — DeepSeek, GLM,
 *   Kimi, MiMo, Hy, Grok.
 * - **Anthropic Messages** (`/v1/messages`) — MiniMax, Qwen.
 *
 * This adapter REUSES `plugins/llm-openai`'s wire layer for the Chat
 * surface and `plugins/llm-anthropic`'s wire layer for the Messages
 * surface. Only the endpoints and auth strategy differ.
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

const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
const OPENCODE_MESSAGES_URL = "https://opencode.ai/zen/go/v1/messages"

function buildOpencodeMessagesHeaders(auth: RunContext["auth"]): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": "minimal-agent-opencode/0.1",
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
  surfaces: ["openai-chat-completions", "anthropic-messages"] satisfies ReadonlyArray<SurfaceId>,

  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
    if (model.surfaceId === "openai-chat-completions") {
      return validateOpenAIRequest(req, model)
    }
    return validateAnthropicRequest(req, model)
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
      const headers = buildOpenAIHeaders({ auth })
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
        throw new Error(`OpenCode Go API ${response.status}: ${text}`)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
    } else if (model.surfaceId === "anthropic-messages") {
      const headers = buildOpencodeMessagesHeaders(auth)
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
        throw new Error(`OpenCode Go API ${response.status}: ${text}`)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
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
