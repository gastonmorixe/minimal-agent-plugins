/**
 * OpenAI `ProviderAdapter` implementation.
 *
 * One adapter, two surfaces. `adapter.run()` dispatches by
 * `ModelEntry.surfaceId`:
 *
 * - `"openai-chat-completions"`     → POST `/v1/chat/completions`, translated by
 *                          `translateOpenAIChatStream`.
 * - `"openai-responses"`→ POST `/v1/responses`, translated by
 *                          `translateOpenAIResponsesStream`.
 *
 * Like the Anthropic adapter, retry / watchdog / observer live one layer
 * up (provider-neutral); this file only knows the wire format. The
 * generic `parseSse` parser ignores the Responses API's `event:` lines
 * and the per-chunk `obfuscation` padding (unknown JSON keys are
 * tolerated).
 *
 * @module llm/providers/openai/adapter
 */

import { openAIApiKeyAuth, openAIOAuthLogin } from "./auth.ts"
import { buildOpenAIChatBody } from "./chat/request-body.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./chat/response-stream.ts"
import { buildOpenAIHeaders } from "./headers.ts"
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
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import type { ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { findOpenAIModelByTags, registerOpenAIModels } from "./models.ts"
import { callOpenAIResponsesCompact, compactOutputToMessages } from "./responses/compact.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"
import { fetchOpenAISessionInfo, setOpenAIRateLimits } from "./session-info.ts"
import { openAIChatCompletionsCodec } from "./surface-codecs.ts"
import { validateOpenAIRequest } from "./validate.ts"
import {
  CHAT_COMPLETIONS_PATH,
  CHAT_COMPLETIONS_URL,
  CHATGPT_CODEX_RESPONSES_PATH,
  RESPONSES_PATH,
  RESPONSES_URL,
} from "./wire-constants.ts"

/**
 * OpenAI adapter (Chat Completions + Responses). Singleton; register
 * once at module load via {@link bootstrapOpenAI}.
 */
export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  surfaces: ["openai-chat-completions", "openai-responses"] satisfies ReadonlyArray<SurfaceId>,

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
      throw new Error("OpenAI adapter: missing api-key")
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("OpenAI adapter: missing oauth token")
    }

    const headers = buildOpenAIHeaders({ auth })
    // Net seam (Wave D): the client crosses the provider port via
    // `ctx.networkClient`, populated by the host orchestrator (`src/llm/run.ts`)
    // with its shared `defaultNetworkClient` (or a test-injected client). The
    // plugin owns no global, so an absent client is a host wiring bug, not a
    // silent fallback to a singleton this package can't import.
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) {
      throw new Error("OpenAI adapter: missing ctx.networkClient (host must provide the client)")
    }

    if (model.surfaceId === "openai-chat-completions") {
      const body = buildOpenAIChatBody(req, model)
      const url = openAIUrl(auth, CHAT_COMPLETIONS_PATH, CHAT_COMPLETIONS_URL)
      ctx.debug?.header(`POST ${url}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("surface", "chat")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "openai.chat.completions",
        method: "POST",
        url,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!response.ok) {
        const text = await response.text()
        throw taggedHttpError("OpenAI Chat API", response.status, text)
      }
      // Capture rate-limit headers for the status-bar footer. Best-effort +
      // non-throwing; no behavior change to the stream below.
      setOpenAIRateLimits(response.headers)
      if (!response.body) {
        throw new Error("OpenAI Chat API: empty response body for stream")
      }
      yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
      return
    }

    if (model.surfaceId === "openai-responses") {
      const body = buildOpenAIResponsesBody(req, model)
      if (auth.kind === "oauth") {
        body.store = false
        delete body.max_output_tokens
      }
      // Invariant: `previous_response_id` only works when the server kept the
      // prior turn (`store:true`). With `store:false` (the default, and forced
      // on OAuth/ChatGPT-Codex) there is no server-side chain to resume, so a
      // stray pointer would 400 or silently desync. Strip it rather than ship
      // a request that can't succeed. See request-body.ts (maps previousResponseId)
      // and validate.ts (gates it on serverSideHistory).
      if (body.store !== true && body.previous_response_id !== undefined) {
        delete body.previous_response_id
        ctx.debug?.kv("previous_response_id", "dropped (store!=true)")
      }
      const url = openAIUrl(auth, RESPONSES_PATH, RESPONSES_URL, CHATGPT_CODEX_RESPONSES_PATH)
      ctx.debug?.header(`POST ${url}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("surface", "responses")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "openai.responses",
        method: "POST",
        url,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!response.ok) {
        const text = await response.text()
        throw taggedHttpError("OpenAI Responses API", response.status, text)
      }
      // Capture rate-limit headers for the status-bar footer. Best-effort +
      // non-throwing; no behavior change to the stream below.
      setOpenAIRateLimits(response.headers)
      if (!response.body) {
        throw new Error("OpenAI Responses API: empty response body for stream")
      }
      yield* translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(response.body))
      return
    }

    throw new Error(
      `OpenAI adapter: model ${model.id} has unsupported surface "${model.surfaceId}"`,
    )
  },

  /**
   * Recommend OpenAI models per abstract sub-agent role, from THIS provider's
   * own catalog by tag (never a hardcoded SKU). scout → a fast gpt-4-class
   * chat model, balanced → the flagship chat model, deep → the flagship
   * reasoning model. A role with no matching model is omitted (caller falls
   * back to the lead's model).
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const byTier: Array<{ role: string; tags: string[] }> = [
      { role: "scout", tags: ["chat", "fast"] },
      { role: "balanced", tags: ["flagship", "chat"] },
      { role: "deep", tags: ["flagship", "reasoning"] },
    ]
    const recs: SubagentModelRecommendation[] = []
    for (const { role, tags } of byTier) {
      const modelId = findOpenAIModelByTags(tags)
      if (modelId) recs.push({ role, modelId })
    }
    return recs
  },

  /**
   * Remote history compaction via `POST /responses/compact` (API key) or
   * ChatGPT-Codex OAuth sibling path. Only meaningful on the Responses
   * surface; Chat Completions has no compact endpoint.
   */
  async compact(input, model, ctx) {
    if (model.surfaceId !== "openai-responses") {
      throw new Error(
        `OpenAI compact: model ${model.id} surface "${model.surfaceId}" has no remote compact API`,
      )
    }
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error("OpenAI compact: missing api-key")
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("OpenAI compact: missing oauth token")
    }
    const headers = buildOpenAIHeaders({ auth })
    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) {
      throw new Error("OpenAI compact: missing ctx.networkClient")
    }
    const output = await callOpenAIResponsesCompact({
      req: input.req,
      model,
      ctx,
      headers,
      networkClient,
    })
    return {
      kind: "remote" as const,
      replacementMessages: compactOutputToMessages(output),
      rawOutput: output,
    }
  },
}

function openAIUrl(auth: ProviderAuth, path: string, fallback: string, oauthPath = path): string {
  if (auth.kind !== "oauth" || !auth.baseUrl) return fallback
  return `${auth.baseUrl.replace(/\/+$/, "")}${oauthPath}`
}

/**
 * Best-effort pull of the OpenAI error `code`/`type` out of a non-2xx body.
 * OpenAI error bodies are `{"error":{"message":"…","type":"…","code":"…"}}`.
 * Returns the `code` (or `type` fallback), lowercased by the classifier.
 */
function parseOpenAIErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a tagged HTTP error so the provider-neutral retry coordinator can
 * recover from a pre-stream rejection (429 rate limit, 5xx overload, …)
 * instead of stopping the agent. Mirrors the Anthropic `client.ts` path:
 * map the status (+ body error code) to a `streamErrorType` the retry loop
 * understands; leave it untagged for non-transient failures so they
 * propagate.
 */
function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseOpenAIErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`${label} ${status}: ${body}`) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

/**
 * Register the OpenAI adapter + its model catalog into the global
 * registry. Idempotent. Call once at application start (alongside
 * `bootstrapAnthropic()`). After this, `resolveModel("gpt-5.5")` and
 * `run()` can reach the OpenAI surfaces.
 *
 * Registry seam (Wave D): when the host passes a {@link ProviderSetupContext}
 * (via `register(ctx)`), the model catalog is contributed through
 * `ctx.models` (the `models:register` capability) instead of the direct
 * registry import. Without a context (the legacy no-arg activation path) it
 * falls back to {@link registerOpenAIModels}'s own import. The adapter itself
 * still registers through {@link registerProvider} (the provider-adapter port
 * has not moved to a capability yet — see D-net-seam §3).
 *
 * @param ctx - Optional host setup context carrying the model registrar.
 */
export function bootstrapOpenAI(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  registerOpenAIModels(ctx.models)
  ctx.surfaceCodecs?.register(openAIChatCompletionsCodec)
  ctx.providers.register(openaiAdapter)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const openaiProviderPlugin: ProviderPlugin = {
  id: "openai",
  displayName: "OpenAI",
  shortCode: "oai",
  register: bootstrapOpenAI,
  apiKeyAuth: openAIApiKeyAuth,
  oauthLogin: openAIOAuthLogin,
  fetchSessionInfo: fetchOpenAISessionInfo,
  /**
   * Version token for dense labels: "gpt-<rest>" → rest minus trailing
   * date / "-chat" alias (gpt-5.5-chat → 5.5); o-series ("o3", "o4-mini")
   * pass through minus date suffixes. Undefined for foreign schemes.
   */
  modelVersionToken(modelId: string): string | undefined {
    const gpt = modelId.match(/^gpt-(.+)$/)
    if (gpt) return gpt[1].replace(/-\d{6,}.*$/, "").replace(/-chat$/, "")
    if (/^o\d/.test(modelId)) return modelId.replace(/-\d{6,}.*$/, "")
    return undefined
  },
}

export type { ProviderAuth }
