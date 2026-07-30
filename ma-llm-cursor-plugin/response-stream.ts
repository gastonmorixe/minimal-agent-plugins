/**
 * Connect frames → AsyncIterable of CanonicalEvent.
 *
 * Maps text_delta → text_start/delta/stop, thinking_delta → thinking_*,
 * tool_call_* → tool_use_* + stopReason tool_use (MA executes tools).
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
import type { DecodedCursorMcpToolCall } from "./proto/tool-call-decode.ts"

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
  let pendingToolIndex: number | undefined
  let pendingToolId: string | undefined
  let pendingToolName: string | undefined
  let pendingToolInput: Record<string, unknown> | undefined
  let sawToolUse = false
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

  const emitToolUseStop = function* (): Generator<CanonicalEvent> {
    if (pendingToolIndex === undefined || !pendingToolId || !pendingToolName) return
    const input = pendingToolInput ?? {}
    yield {
      type: "tool_use_input_delta",
      index: pendingToolIndex,
      partialJson: JSON.stringify(input),
    }
    yield {
      type: "tool_use_stop",
      index: pendingToolIndex,
      input,
    }
    pendingToolIndex = undefined
    pendingToolId = undefined
    pendingToolName = undefined
    pendingToolInput = undefined
  }

  const finishMessage = function* (stopReason: "end_turn" | "tool_use"): Generator<CanonicalEvent> {
    yield* closeText()
    yield* closeThinking()
    yield* emitToolUseStop()
    yield* openMessage()
    yield {
      type: "message_delta",
      stopReason,
      usage: emptyUsage,
    }
    yield { type: "message_stop" }
  }

  const handleMcpToolCall = function* (
    call: DecodedCursorMcpToolCall | undefined,
    phase: "started" | "completed",
  ): Generator<CanonicalEvent, boolean> {
    if (!call) return false
    if (call.builtinOneof && call.builtinOneof !== "mcpToolCall") {
      // Native built-in slipped through — ignore; exclude headers should prevent this.
      return false
    }
    const name = call.maToolName ?? call.toolName
    if (!name) return false

    if (phase === "started") {
      yield* openMessage()
      yield* closeText()
      yield* closeThinking()
      pendingToolIndex = blockIndex++
      pendingToolId = call.callId || crypto.randomUUID()
      pendingToolName = name
      pendingToolInput = call.input
      sawToolUse = true
      yield {
        type: "tool_use_start",
        index: pendingToolIndex,
        id: pendingToolId,
        name: pendingToolName,
      }
      if (call.input && Object.keys(call.input).length > 0) {
        yield* emitToolUseStop()
      }
      return true
    }

    // completed — merge args if we started earlier without input
    if (pendingToolIndex !== undefined && call.input) {
      pendingToolInput = { ...(pendingToolInput ?? {}), ...call.input }
    }
    if (pendingToolIndex === undefined && phase === "completed") {
      yield* openMessage()
      pendingToolIndex = blockIndex++
      pendingToolId = call.callId || crypto.randomUUID()
      pendingToolName = name
      pendingToolInput = call.input
      sawToolUse = true
      yield {
        type: "tool_use_start",
        index: pendingToolIndex,
        id: pendingToolId,
        name: pendingToolName,
      }
    }
    yield* emitToolUseStop()
    return true
  }

  const handleEvents = function* (events: CursorServerEvent[]): Generator<CanonicalEvent, boolean> {
    let endAfterTool = false
    for (const ev of events) {
      if (ev.kind === "heartbeat") continue
      if (ev.kind === "tool_call_started") {
        if (yield* handleMcpToolCall(ev.toolCall, "started")) {
          endAfterTool = true
        }
        continue
      }
      if (ev.kind === "tool_call_completed") {
        yield* handleMcpToolCall(ev.toolCall, "completed")
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
        yield* finishMessage(sawToolUse ? "tool_use" : "end_turn")
      }
    }
    return endAfterTool
  }

  for await (const chunk of chunks) {
    for (const frame of reader.push(chunk)) {
      const endAfterTool = yield* handleFrame(frame, handleEvents)
      if (endAfterTool || sawTurnEnded) {
        if (endAfterTool && !sawTurnEnded) {
          yield* finishMessage("tool_use")
        }
        return
      }
    }
  }

  if (started && !sawTurnEnded) {
    yield* finishMessage(sawToolUse ? "tool_use" : "end_turn")
  }
}

function* handleFrame(
  frame: ConnectEnvelope,
  handleEvents: (events: CursorServerEvent[]) => Generator<CanonicalEvent, boolean>,
): Generator<CanonicalEvent, boolean> {
  if (frame.endStream) {
    const parsed = parseConnectEndStreamError(frame.payload)
    if (parsed) {
      const cause = new Error(parsed.message)
      yield {
        type: "stream_error",
        retryable: false,
        category: categoryFromConnectCode(parsed.code),
        upstreamType: (parsed.code ?? "connect_end_stream").slice(0, 200),
        cause,
      }
    }
    return false
  }
  if (frame.payload.length === 0) return false
  return yield* handleEvents(extractServerTextEvents(frame.payload))
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
    yield buf
  }
  void parseConnectFrames
  yield* translateCursorStream(frames(), opts)
}
