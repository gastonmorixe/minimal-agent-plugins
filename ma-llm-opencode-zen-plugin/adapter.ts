/** OpenCode Zen OpenAI-compatible Chat Completions provider. */
import { opencodeApiKeyAuth } from "./auth.ts"
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

export const OPENCODE_ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions"

export const opencodeZenAdapter: ProviderAdapter = {
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  surfaces: ["openai-chat-completions"] satisfies ReadonlyArray<SurfaceId>,

  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
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
        "OpenCode Zen adapter: missing api-key (run `minimal-agent provider opencode-zen login)`",
      )
    }
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("opencode-zen: no network client on RunContext")

    const headers = buildOpenAIHeaders({ auth, userAgent: "minimal-agent-opencode-zen/0.1" })
    const body = buildOpenAIChatBody(req, model)
    const response = await networkClient.request({
      label: "opencode-zen.chat.completions",
      method: "POST",
      url: OPENCODE_ZEN_CHAT_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok)
      throw new Error(`OpenCode Zen API ${response.status}: ${await response.text()}`)
    if (!response.body) throw new Error("OpenCode Zen API: empty response body for stream")
    yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
  },
}

let capturedModels: ModelRegistrar | undefined

/** Register the OpenCode Zen adapter and built-in catalog. */
export function bootstrapOpencodeZen(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerOpencodeZenModels(ctx.models)
  ctx.providers.register(opencodeZenAdapter)
}

/** Register a one-off Zen model using the conservative chat fallback. */
export function registerOpencodeZenAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerOpencodeZenModelInto(capturedModels, modelId)
}

export const opencodeProviderPlugin: ProviderPlugin = {
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  shortCode: "oz",
  register: bootstrapOpencodeZen,
  registerAdHocModel: registerOpencodeZenAdHocModel,
  apiKeyAuth: opencodeApiKeyAuth,
}
