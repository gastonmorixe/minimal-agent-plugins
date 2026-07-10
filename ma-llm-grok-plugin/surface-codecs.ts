/**
 * Surface codecs for Grok / OpenAI-compatible wire surfaces.
 *
 * Registers with the host generic-endpoint provider so operators can also
 * point arbitrary URLs at Grok-compatible chat without a second plugin.
 *
 * @module llm/providers/grok/surface-codecs
 */

import { CAPS_GROK_45_CHAT } from "./capabilities.ts"
import { buildGrokHeaders } from "./headers.ts"
import { classifyUpstreamError } from "./lib/errors.ts"
import {
  buildOpenAIChatBody,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "./lib/openai-chat.ts"
import { parseSse } from "./lib/sse-parser.ts"
import type { SurfaceCodec } from "./lib/surface-codec.ts"
import { PRICING_GROK_45 } from "./pricing.ts"
import { setGrokRateLimits } from "./session-info.ts"
import { validateOpenAIRequest } from "./validate.ts"

function parseErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

export const grokChatCompletionsCodec: SurfaceCodec = {
  surfaceId: "openai-chat-completions",
  displayName: "Grok / OpenAI Chat Completions",
  defaultPath: "/v1/chat/completions",
  defaultCapabilities: CAPS_GROK_45_CHAT,
  defaultPricing: PRICING_GROK_45,
  defaultTags: ["generic", "openai-compatible", "grok"],
  validate: validateOpenAIRequest,
  buildRequest({ req, model, auth, endpoint }) {
    const body = buildOpenAIChatBody(req, model)
    const wireId = model.vendorIds?.firstParty ?? req.modelId
    body.model = wireId
    return {
      label: "generic.grok.chat.completions",
      method: "POST",
      url: endpoint,
      headers: buildGrokHeaders({ auth, modelId: wireId }),
      body: JSON.stringify(body),
      signal: req.signal,
    }
  },
  async *translateStream({ body }) {
    yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(body))
  },
  classifyError(status, body) {
    const upstreamCode = parseErrorCode(body)
    const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
    const err = new Error(`Grok-compatible Chat API ${status}: ${body}`) as Error & {
      streamErrorType?: string
    }
    if (streamErrorType) err.streamErrorType = streamErrorType
    return err
  },
  onResponseHeaders: setGrokRateLimits,
}
