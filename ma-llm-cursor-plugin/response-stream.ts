/**
 * Connect frames → AsyncIterable of CanonicalEvent.
 *
 * Maps text_delta → text_start/delta/stop, thinking_delta → thinking_*,
 * turn_ended → message_delta + message_stop. MVP ignores tool_call_*.
 *
 * @module llm/providers/cursor/response-stream
 */

import type { ConnectEnvelope } from "./connect/stream.ts"
import { ConnectFrameReader, parseConnectFrames } from "./connect/stream.ts"
import type { CanonicalEvent, CanonicalUsage } from "./lib/canonical-events.ts"
import {
  type CursorServerEvent,
  extractServerTextEvents,
  parseConnectEndStreamError,
} from "./proto/agent-run.ts"

export type TranslateCursorStreamOpts = {
  modelId: string
  messageId?: string
}

/**
 * Translate a Connect response byte stream into canonical events.
 */
export async function* translateCursorStream(
  chunks: AsyncIterable<Uint8Array>,
  opts: TranslateCursorStreamOpts,
): AsyncGenerator<CanonicalEvent> {
  const reader = new ConnectFrameReader()
  const messageId = opts.messageId ?? crypto.randomUUID()
  let started = false
  let textOpen = false
  let thinkingOpen = false
  let textIndex = 0
  let thinkingIndex = 0
  let blockIndex = 0
  let sawTurnEnded = false
  const emptyUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }

  const openMessage = function* (): Generator<CanonicalEvent> {
    if (started) return
    started = true
    yield {
      type: "message_start",
      messageId,
      modelId: opts.modelId,
      initialUsage: emptyUsage,
    }
  }

  const closeText = function* (): Generator<CanonicalEvent> {
    if (!textOpen) return
    yield { type: "text_stop", index: textIndex }
    textOpen = false
  }

  const closeThinking = function* (): Generator<CanonicalEvent> {
    if (!thinkingOpen) return
    yield { type: "thinking_stop", index: thinkingIndex }
    thinkingOpen = false
  }

  const handleEvents = function* (events: CursorServerEvent[]): Generator<CanonicalEvent> {
    for (const ev of events) {
      if (ev.kind === "heartbeat") continue
      if (ev.kind === "tool_call_started" || ev.kind === "tool_call_completed") {
        // MVP: MA owns tools; ignore Cursor tool protocol.
        continue
      }
      if (ev.kind === "text_delta" && ev.text) {
        yield* openMessage()
        yield* closeThinking()
        if (!textOpen) {
          textIndex = blockIndex++
          textOpen = true
          yield { type: "text_start", index: textIndex }
        }
        yield { type: "text_delta", index: textIndex, text: ev.text }
      } else if (ev.kind === "thinking_delta" && ev.text) {
        yield* openMessage()
        yield* closeText()
        if (!thinkingOpen) {
          thinkingIndex = blockIndex++
          thinkingOpen = true
          yield { type: "thinking_start", index: thinkingIndex }
        }
        yield { type: "thinking_delta", index: thinkingIndex, text: ev.text }
      } else if (ev.kind === "turn_ended") {
        sawTurnEnded = true
        yield* closeText()
        yield* closeThinking()
        yield* openMessage()
        yield {
          type: "message_delta",
          stopReason: "end_turn",
          usage: emptyUsage,
        }
        yield { type: "message_stop" }
      }
    }
  }

  for await (const chunk of chunks) {
    for (const frame of reader.push(chunk)) {
      yield* handleFrame(frame, handleEvents)
      if (sawTurnEnded) return
    }
  }

  // Flush any remaining incomplete? none — incomplete frames stay in remainder.
  if (started && !sawTurnEnded) {
    yield* closeText()
    yield* closeThinking()
    yield {
      type: "message_delta",
      stopReason: "end_turn",
      usage: emptyUsage,
    }
    yield { type: "message_stop" }
  }
}

function* handleFrame(
  frame: ConnectEnvelope,
  handleEvents: (events: CursorServerEvent[]) => Generator<CanonicalEvent>,
): Generator<CanonicalEvent> {
  if (frame.endStream) {
    const parsed = parseConnectEndStreamError(frame.payload)
    if (parsed) {
      // Host only surfaces `cause` when it is an Error instance
      // (adapter-legacy taggedStreamError). Keep message free of secrets.
      const cause = new Error(parsed.message)
      yield {
        type: "stream_error",
        retryable: false,
        category: categoryFromConnectCode(parsed.code),
        upstreamType: (parsed.code ?? "connect_end_stream").slice(0, 200),
        cause,
      }
    }
    return
  }
  if (frame.payload.length === 0) return
  yield* handleEvents(extractServerTextEvents(frame.payload))
}

/** Map Connect error codes onto canonical stream_error categories. */
function categoryFromConnectCode(
  code: string | undefined,
): NonNullable<Extract<CanonicalEvent, { type: "stream_error" }>["category"]> {
  if (!code) return "api"
  const c = code.toLowerCase()
  if (c.includes("unauth") || c.includes("permission") || c.includes("forbidden")) return "auth"
  if (c.includes("resource_exhausted") || c.includes("rate")) return "rate_limit"
  if (c.includes("unavailable") || c.includes("overloaded")) return "overloaded"
  if (c.includes("deadline") || c.includes("timeout") || c.includes("canceled")) return "timeout"
  return "api"
}

/**
 * Translate a complete offline Connect response buffer (fixture tests).
 */
export async function* translateCursorStreamBuffer(
  buf: Uint8Array,
  opts: TranslateCursorStreamOpts,
): AsyncGenerator<CanonicalEvent> {
  async function* frames(): AsyncGenerator<Uint8Array> {
    // Feed whole buffer as one chunk (parseConnectFrames used internally via reader).
    yield buf
  }
  // Ensure parseConnectFrames path is covered for multi-frame offline buffers
  void parseConnectFrames
  yield* translateCursorStream(frames(), opts)
}
