/**
 * Gemini `streamGenerateContent` SSE to CanonicalEvent translator.
 *
 * Each SSE frame is one `{response:{candidates,usageMetadata}}` object (see
 * `research/2026-11-25-antigravity-plugin/notes/wire.md` 4.4). The frames of a
 * turn are a sequence of parts, not a diff: consecutive `text` parts concatenate,
 * consecutive `thought` text parts concatenate, and a `functionCall` arrives
 * whole with its arguments already parsed.
 *
 * Three shapes come from live probes
 * (`research/2026-11-25-antigravity-plugin/logs/probe-tool-loop2-20261125.log`):
 *
 * 1. `thoughtSignature` is a sibling of `functionCall` in the same part. It
 *    goes to `signatureSink` and to nothing thinking shaped: core drops the
 *    thinking blocks of every non-last assistant message, so a thinking block
 *    cannot carry the signature through a tool loop.
 * 2. An empty `text` part is a no-op. Claude opens its tool turn with one.
 * 3. The final frame carries `finishReason` and the usage counts of the whole
 *    turn, with `promptTokenCount` INCLUDING `cachedContentTokenCount`.
 *
 * @module llm/providers/antigravity/response-stream
 */

import { randomUUID } from "node:crypto"

import type {
  CanonicalEvent,
  CanonicalUsage,
  StopReason,
} from "@minimal-agent/core/plugin-api/llm/canonical-events"

import { parseGoogleError, taggedAntigravityError } from "./error-class.ts"

/** One part of the Gemini response shape. */
export interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name?: string; args?: unknown }
  functionResponse?: unknown
  inlineData?: unknown
}

/** Usage counters of a frame. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

/** One SSE frame of the backend. */
export interface GeminiSseFrame {
  response?: {
    candidates?: Array<{
      content?: { role?: string; parts?: GeminiPart[] }
      finishReason?: string
    }>
    usageMetadata?: GeminiUsageMetadata
    modelVersion?: string
    responseId?: string
  }
  traceId?: string
  error?: { code?: number; message?: string; status?: string }
}

/** Options of {@link translateAntigravityStream}. */
export interface TranslateOptions {
  /** Wire model id, for `message_start`. */
  modelId: string
  /** Mints an id when the backend sends a tool call with none. */
  mintId?: () => string
  /** Receives `(toolUseId, signature)` for each signed tool call. */
  signatureSink?: (toolUseId: string, signature: string) => void
}

/** Stop reasons the backend can report. */
const FINISH_REASONS: Readonly<Record<string, StopReason>> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  MALFORMED_FUNCTION_CALL: "error",
}

/** Canonical usage of a frame: input excludes the cached prompt tokens. */
function toUsage(raw: GeminiUsageMetadata | undefined): CanonicalUsage {
  const prompt = raw?.promptTokenCount ?? 0
  const cached = raw?.cachedContentTokenCount ?? 0
  const usage: CanonicalUsage = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: raw?.candidatesTokenCount ?? 0,
  }
  if (cached > 0) usage.cacheReadTokens = cached
  if ((raw?.thoughtsTokenCount ?? 0) > 0) usage.reasoningTokens = raw?.thoughtsTokenCount
  return usage
}

/** A tool call the frame stream emitted, for the stop reason. */
interface ToolCall {
  id: string
  name: string
}

/**
 * Translate a Gemini SSE frame stream into canonical events.
 *
 * The translator keeps the open block index, so a frame may carry a text part,
 * a thought part and a tool call in one message. A block opens on the first
 * frame that carries it and closes when a different kind arrives or the turn
 * ends.
 *
 * @param frames - Parsed JSON objects of the SSE `data:` lines.
 * @param opts - Model id, id minter and signature sink.
 * @yields Canonical events of one assistant message, ending with
 *   `message_delta` and `message_stop`.
 */
export async function* translateAntigravityStream(
  frames: AsyncIterable<GeminiSseFrame>,
  opts: TranslateOptions,
): AsyncIterable<CanonicalEvent> {
  let started = false
  let index = 0
  let openText: number | null = null
  let openThinking: number | null = null
  const toolCalls: ToolCall[] = []
  let stopReason: StopReason | null = null
  let usage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  let messageId = ""
  let minted = 0
  // A random stream tag keeps a fallback id unique across turns, so two turns
  // never share a key in the signature cache.
  const streamTag = randomUUID().replace(/-/g, "").slice(0, 12)

  const closeBlocks = function* (): Generator<CanonicalEvent> {
    if (openThinking !== null) {
      yield { type: "thinking_stop", index: openThinking }
      openThinking = null
    }
    if (openText !== null) {
      yield { type: "text_stop", index: openText }
      openText = null
    }
  }

  for await (const frame of frames) {
    if (frame.error) {
      const status = frame.error.code ?? 500
      throw taggedAntigravityError(status, JSON.stringify(frame.error), null)
    }
    const response = frame.response
    if (!response) continue

    if (!started) {
      started = true
      messageId = response.responseId ?? `antigravity-${Date.now()}`
      yield { type: "message_start", messageId, modelId: opts.modelId, initialUsage: usage }
    }
    if (response.usageMetadata) usage = toUsage(response.usageMetadata)

    const candidate = response.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        for (const event of closeBlocks()) yield event
        const name = part.functionCall.name ?? "tool"
        const id =
          part.functionCall.id ?? opts.mintId?.() ?? `antigravity_tool_${streamTag}_${minted++}`
        const input = part.functionCall.args ?? {}
        const toolIndex = index++
        yield { type: "tool_use_start", index: toolIndex, id, name }
        yield { type: "tool_use_input_delta", index: toolIndex, partialJson: JSON.stringify(input) }
        yield { type: "tool_use_stop", index: toolIndex, input }
        if (part.thoughtSignature) opts.signatureSink?.(id, part.thoughtSignature)
        toolCalls.push({ id, name })
        continue
      }
      if (typeof part.text !== "string") continue
      if (part.text.length === 0) continue

      if (part.thought) {
        if (openText !== null) {
          yield { type: "text_stop", index: openText }
          openText = null
        }
        if (openThinking === null) {
          openThinking = index++
          yield { type: "thinking_start", index: openThinking }
        }
        yield { type: "thinking_delta", index: openThinking, text: part.text }
        continue
      }

      if (openThinking !== null) {
        yield { type: "thinking_stop", index: openThinking }
        openThinking = null
      }
      if (openText === null) {
        openText = index++
        yield { type: "text_start", index: openText }
      }
      yield { type: "text_delta", index: openText, text: part.text }
    }

    const finish = candidate?.finishReason
    if (finish) {
      stopReason = FINISH_REASONS[finish] ?? "end_turn"
      if (stopReason === "end_turn" && toolCalls.length > 0) stopReason = "tool_use"
    }
  }

  if (!started) {
    messageId = `antigravity-${Date.now()}`
    yield { type: "message_start", messageId, modelId: opts.modelId, initialUsage: usage }
  }
  for (const event of closeBlocks()) yield event
  if (stopReason === null) stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn"
  yield { type: "message_delta", stopReason, usage }
  yield { type: "message_stop" }
}

/** One Markdown code fence (three backticks, an optional `json` tag) around the whole text. */
const WHOLE_FENCE = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/u

/**
 * Remove one code fence around the whole reply of a JSON schema call.
 *
 * Gemini can wrap a schema reply in a fence even with `responseMimeType`
 * set (live reply on 2026-11-27). gemini-cli also strips it before it parses
 * (`packages/core/src/core/baseLlmClient.ts` `generateJson`,
 * https://github.com/google-gemini/gemini-cli). A text with no fence, or
 * with a fence inside other text, does not change.
 */
export function stripJsonFence(text: string): string {
  const m = WHOLE_FENCE.exec(text)
  return m ? (m[1] ?? "").trim() : text
}

/**
 * The events of a JSON schema call: the text of the turn goes out as one
 * text block with the fence removed ({@link stripJsonFence}). Thinking and
 * tool events pass through. The text block opens at the index of the first
 * text event, and closes before `message_delta`.
 */
export async function* unfenceJsonText(
  events: AsyncIterable<CanonicalEvent>,
): AsyncIterable<CanonicalEvent> {
  let textIndex: number | null = null
  let text = ""
  for await (const ev of events) {
    if (ev.type === "text_start") {
      if (textIndex === null) textIndex = ev.index
      continue
    }
    if (ev.type === "text_delta") {
      text += ev.text
      continue
    }
    if (ev.type === "text_stop") continue
    if (ev.type === "message_delta" && textIndex !== null) {
      yield { type: "text_start", index: textIndex }
      yield { type: "text_delta", index: textIndex, text: stripJsonFence(text) }
      yield { type: "text_stop", index: textIndex }
      textIndex = null
    }
    yield ev
  }
}

/** Parse a non-2xx body into a tagged error, for the adapter's fetch path. */
export function antigravityHttpError(
  status: number,
  body: string,
  headers?: { get(name: string): string | null } | null,
): Error {
  void parseGoogleError(body)
  return taggedAntigravityError(status, body, headers)
}
