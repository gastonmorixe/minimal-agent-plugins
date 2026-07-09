/**
 * Surface codecs exported by the OpenAI provider.
 *
 * These codecs expose reusable wire logic for the generic endpoint provider
 * without coupling that provider to OpenAI plugin internals or fixed endpoints.
 *
 * @module llm/providers/openai/surface-codecs
 */

import { CAPS_GPT_4O_CHAT } from "./capabilities.ts"
import { buildOpenAIChatBody } from "./chat/request-body.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./chat/response-stream.ts"
import { buildOpenAIHeaders } from "./headers.ts"
import { classifyUpstreamError } from "./lib/errors.ts"
import { parseSse } from "./lib/sse-parser.ts"
import type { SurfaceCodec } from "./lib/surface-codec.ts"
import { PRICING_GPT_4O } from "./pricing.ts"
import { setOpenAIRateLimits } from "./session-info.ts"
import { validateOpenAIRequest } from "./validate.ts"

function parseOpenAIErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

export const openAIChatCompletionsCodec: SurfaceCodec = {
  surfaceId: "openai-chat-completions",
  displayName: "OpenAI Chat Completions",
  defaultPath: "/v1/chat/completions",
  defaultCapabilities: CAPS_GPT_4O_CHAT,
  defaultPricing: PRICING_GPT_4O,
  defaultTags: ["generic", "openai-compatible"],
  validate: validateOpenAIRequest,
  buildRequest({ req, model, auth, endpoint }) {
    const body = buildOpenAIChatBody(req, model)
    return {
      label: "generic.openai.chat.completions",
      method: "POST",
      url: endpoint,
      headers: buildOpenAIHeaders({ auth }),
      body: JSON.stringify(body),
      signal: req.signal,
    }
  },
  async *translateStream({ body }) {
    yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(body))
  },
  classifyError(status, body) {
    const upstreamCode = parseOpenAIErrorCode(body)
    const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
    const err = new Error(`OpenAI-compatible Chat API ${status}: ${body}`) as Error & {
      streamErrorType?: string
    }
    if (streamErrorType) err.streamErrorType = streamErrorType
    return err
  },
  onResponseHeaders: setOpenAIRateLimits,
}
