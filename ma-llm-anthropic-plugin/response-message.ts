/**
 * Non-stream Messages response (`stream: false`) → the SSE event sequence.
 *
 * With `stream: false` the API returns one `Message` JSON object, not an SSE
 * stream (https://docs.claude.com/en/api/messages/create, "Returns: Message").
 * This module changes that object into the same event sequence that a stream
 * gives (`message_start`, one start/delta/stop group for each content block,
 * `message_delta`, `message_stop`). The adapter then sends the sequence
 * through the one translator (`translateAnthropicStream`), so the canonical
 * events are the same for the two modes.
 *
 * @module llm/providers/anthropic/response-message
 */

import type { AnthropicStreamEvent } from "./response-stream.ts"

/** The part of the non-stream `Message` object that the adapter reads. */
export interface AnthropicMessageWire {
  type?: string
  id?: string
  model?: string
  content?: ReadonlyArray<Record<string, unknown>>
  stop_reason?: string | null
  stop_sequence?: string | null
  stop_details?: { type: string; message?: string } | null
  usage?: Record<string, unknown>
  context_management?: { applied_edits: unknown[] }
  error?: { type?: string; message?: string }
}

/** The usage wire type of the stream translator (same fields in the two modes). */
type UsageWire = Extract<AnthropicStreamEvent, { type: "message_start" }>["message"]["usage"]

/** True when the value is a string. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/**
 * Change one non-stream `Message` object into the SSE event sequence.
 * An `{type:"error"}` body gives one `error` event. A content block of an
 * unknown type is skipped (the stream translator also skips it).
 *
 * @param msg - The parsed response body.
 * @returns The events, in stream order.
 */
export function messageToStreamEvents(msg: AnthropicMessageWire): AnthropicStreamEvent[] {
  if (msg.type === "error") {
    return [{ type: "error", error: msg.error ?? {} }]
  }
  const usage = msg.usage as UsageWire | undefined
  const events: AnthropicStreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: msg.id ?? "",
        model: msg.model ?? "",
        usage,
        stop_details: null,
      },
    },
  ]
  const blocks = msg.content ?? []
  blocks.forEach((block, index) => {
    const kind = str(block.type)
    if (kind === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
      const text = str(block.text) ?? ""
      if (text) {
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text } })
      }
      events.push({ type: "content_block_stop", index })
    } else if (kind === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "thinking",
          thinking: str(block.thinking) ?? "",
          ...(str(block.signature) ? { signature: str(block.signature) } : {}),
        },
      })
      events.push({ type: "content_block_stop", index })
    } else if (kind === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: str(block.id) ?? "", name: str(block.name) ?? "" },
      })
      const input = JSON.stringify(block.input ?? {})
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: input },
      })
      events.push({ type: "content_block_stop", index })
    }
  })
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: msg.stop_reason ?? null,
      stop_sequence: msg.stop_sequence ?? null,
      stop_details: msg.stop_details ?? null,
    },
    usage,
    ...(msg.context_management ? { context_management: msg.context_management } : {}),
  })
  events.push({ type: "message_stop" })
  return events
}

/**
 * True when the response is one JSON `Message` and not an SSE stream: the
 * request had `stream: false` and the server did not answer with
 * `text/event-stream`.
 */
export function isJsonMessageResponse(
  requestStream: boolean | undefined,
  headers: Headers,
): boolean {
  if (requestStream !== false) return false
  const type = headers.get("content-type") ?? ""
  return !type.includes("text/event-stream")
}

/** Async view of the events, for the stream translator. */
export async function* asEventStream(
  events: readonly AnthropicStreamEvent[],
): AsyncIterable<AnthropicStreamEvent> {
  for (const ev of events) yield ev
}
