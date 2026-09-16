/**
 * DeepSeek `ProviderAdapter`.
 *
 * DeepSeek (api.deepseek.com) speaks the OpenAI Chat Completions wire format, so
 * this adapter REUSES the shared OpenAI wire layer (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, `buildOpenAIHeaders`, `validateOpenAIRequest`)
 * and only layers on DeepSeek's specifics:
 *
 * - Endpoint `https://api.deepseek.com/chat/completions` (no `/v1`).
 * - `thinking` toggle + `max_tokens` (see `request-body.ts`).
 * - Chain-of-thought round-trip: DeepSeek requires prior-turn
 *   `reasoning_content` to be echoed back when the request carries `tools`.
 *   This plugin's vendored translator emits a synthetic thinking "signature"
 *   so the host keeps the reasoning block in history, and the vendored Chat
 *   mapper writes it back as `reasoning_content`.
 *
 * Auth: a Bearer API key from minimal-agent's provider auth store.
 *
 * @module llm/providers/deepseek/adapter
 */

import { deepseekApiKeyAuth } from "./auth.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
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
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "./lib/openai-chat.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import type { ModelRegistrar, ProviderPlugin, ProviderSetupContext } from "./lib/provider-plugin.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { listDeepSeekLiveModels } from "./live-models.ts"
import {
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_SURFACE_ID,
  findDeepSeekModelByTags,
  registerDeepSeekModelInto,
  registerDeepSeekModels,
} from "./models.ts"
import { buildDeepSeekChatBody } from "./request-body.ts"
import { CHAT_COMPLETIONS_URL, DEEPSEEK_USER_AGENT } from "./wire-constants.ts"

/**
 * Marker persisted as a thinking block's `signature` so the host's stream
 * accumulator keeps DeepSeek's chain-of-thought in history (it drops unsigned
 * thinking blocks; see `adapter-legacy-stream.ts`). DeepSeek never verifies
 * signatures, and the DeepSeek body builder reads the block's TEXT — this value
 * is a persistence marker only, never sent back to DeepSeek.
 */
const REASONING_SIGNATURE_MARKER = "deepseek-reasoning"

/**
 * Wrap a canonical event stream so each streamed reasoning delta is followed by
 * a synthetic `thinking_signature`. Makes the reasoning block survive the
 * host's "drop unsigned thinking" salvage rule, which is what lets the next
 * request echo `reasoning_content` back to DeepSeek.
 *
 * @param events - Canonical events from the shared OpenAI translator.
 * @yields Canonical events with `thinking_signature` after each reasoning delta.
 */
export async function* withDeepSeekReasoningSignature(
  events: AsyncIterable<CanonicalEvent>,
): AsyncIterable<CanonicalEvent> {
  for await (const ev of events) {
    yield ev
    if (ev.type === "thinking_delta") {
      yield {
        type: "thinking_signature",
        index: ev.index,
        signature: REASONING_SIGNATURE_MARKER,
      }
    }
  }
}

/**
 * Parse an upstream error code out of a non-2xx body. DeepSeek returns the
 * OpenAI error shape: `{"error":{"message":"…","type":"…","code":"…"}}`.
 */
function parseDeepSeekErrorCode(body: string): string | undefined {
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
 * recover from a pre-stream rejection (429 rate limit, 5xx overload) instead of
 * stopping the agent. Terminal verdicts (billing, auth) carry `retryable: false`.
 */
function taggedDeepSeekHttpError(status: number, body: string): TaggedHttpError {
  const upstreamCode = parseDeepSeekErrorCode(body)
  const { streamErrorType, retryable } = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
  })
  const err = new Error(`DeepSeek API ${status}: ${body}`) as TaggedHttpError
  if (streamErrorType) err.streamErrorType = streamErrorType
  if (retryable === false) err.retryable = false
  return err
}

export const deepseekAdapter: ProviderAdapter = {
  id: DEEPSEEK_PROVIDER_ID,
  displayName: "DeepSeek",
  surfaces: [DEEPSEEK_SURFACE_ID] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    return validateOpenAIRequest(req, model)
  },

  async *run(
    req: Parameters<ProviderAdapter["run"]>[0],
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error(
        "DeepSeek adapter: missing api-key (run `minimal-agent provider deepseek login api-key`)",
      )
    }

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) throw new Error("deepseek: no network client on RunContext")

    const headers = buildOpenAIHeaders({ auth, userAgent: DEEPSEEK_USER_AGENT })
    const body = buildDeepSeekChatBody(req, model)

    ctx.debug?.header(`POST ${CHAT_COMPLETIONS_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const response = await networkClient.request({
      label: "deepseek.chat.completions",
      method: "POST",
      url: CHAT_COMPLETIONS_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedDeepSeekHttpError(response.status, text)
    }
    if (!response.body) {
      throw new Error("DeepSeek API: empty response body for stream")
    }
    yield* withDeepSeekReasoningSignature(
      translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body)),
    )
  },

  /**
   * Recommend this provider's own models per abstract sub-agent role. scout →
   * the cheap Flash; balanced → V4 Pro.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    const scout = findDeepSeekModelByTags(["cheap"])
    if (scout) recs.push({ role: "scout", modelId: scout })
    const balanced = findDeepSeekModelByTags(["flagship"])
    if (balanced) recs.push({ role: "balanced", modelId: balanced })
    return recs
  },
}

// The registrar captured at register(ctx) so the ad-hoc hook (called WITHOUT a
// ctx) can still register a wire slug the static catalog doesn't know.
let capturedModels: ModelRegistrar | undefined

/** Register the DeepSeek adapter + catalog through the setup context. */
export function bootstrapDeepSeek(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerDeepSeekModels(ctx.models)
  ctx.providers.register(deepseekAdapter)
}

/** Register a one-off DeepSeek slug that is not in the built-in catalog. */
export function registerDeepSeekAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerDeepSeekModelInto(capturedModels, {
    id: modelId,
    tags: [DEEPSEEK_PROVIDER_ID],
  })
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const deepseekProviderPlugin: ProviderPlugin = {
  id: DEEPSEEK_PROVIDER_ID,
  displayName: "DeepSeek",
  shortCode: "ds",
  register: bootstrapDeepSeek,
  registerAdHocModel: registerDeepSeekAdHocModel,
  apiKeyAuth: deepseekApiKeyAuth,
  listLiveModels: listDeepSeekLiveModels,
}
