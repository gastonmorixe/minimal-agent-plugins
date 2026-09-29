/**
 * A Run that returns HTTP 200 and then closes the stream with no content
 * (usage cap, quota, silent server reject) must surface an error, not an
 * empty turn. Regression: capped accounts showed "no reply, no error".
 */

import { describe, expect, test } from "bun:test"

import type { ConnectEnvelope } from "./connect/stream.ts"
import { concat, encMsg, encString } from "./proto/wire.ts"
import {
  CursorBidiEnvelopeTranslator,
  translateCursorBidiEnvelopes,
} from "./response-stream-bidi.ts"

function env(payload: Uint8Array, endStream = false): ConnectEnvelope {
  return { flags: endStream ? 2 : 0, compressed: false, endStream, payload, rawPayload: payload }
}

/** AgentServerMessage.interaction_update (#1) wrapping one update oneof field. */
function interaction(field: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  return encMsg(1, encMsg(field, body))
}

async function* fromFrames(frames: ConnectEnvelope[]): AsyncGenerator<ConnectEnvelope> {
  for (const f of frames) yield f
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe("empty bidi stream", () => {
  test("finishOnClose on a never-started translator returns a stream_error", () => {
    const t = new CursorBidiEnvelopeTranslator({ modelId: "cursor-auto" })
    const events = t.finishOnClose()
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type !== "stream_error") throw new Error(`expected stream_error, got ${ev?.type}`)
    expect(ev.retryable).toBe(false)
    expect(ev.category).toBe("api")
    expect(ev.upstreamType).toBe("cursor_empty_stream")
    expect(String(ev.cause)).toContain("usage limit")
  })

  test("zero frames yield the error, not nothing", async () => {
    const events = await collect(
      translateCursorBidiEnvelopes(fromFrames([]), { modelId: "cursor-auto" }),
    )
    expect(events.map((e) => e.type)).toEqual(["stream_error"])
  })

  test("only empty heartbeat frames then close is still an error", async () => {
    const events = await collect(
      translateCursorBidiEnvelopes(fromFrames([env(new Uint8Array(0)), env(new Uint8Array(0))]), {
        modelId: "cursor-auto",
      }),
    )
    expect(events.map((e) => e.type)).toEqual(["stream_error"])
  })

  test("end-stream frame with no error body and no content is an error", () => {
    const t = new CursorBidiEnvelopeTranslator({ modelId: "cursor-auto" })
    const { events, streamEnded } = t.push(env(new TextEncoder().encode("{}"), true))
    expect(streamEnded).toBe(true)
    expect(events.map((e) => e.type)).toEqual(["stream_error"])
  })

  test("end-stream frame with a Connect error keeps the server code", () => {
    const t = new CursorBidiEnvelopeTranslator({ modelId: "cursor-auto" })
    const body = new TextEncoder().encode(
      JSON.stringify({ error: { code: "resource_exhausted", message: "usage limit" } }),
    )
    const { events } = t.push(env(body, true))
    const ev = events[0]
    if (ev?.type !== "stream_error") throw new Error("expected stream_error")
    expect(ev.upstreamType).toBe("resource_exhausted")
    expect(events.filter((e) => e.type === "stream_error")).toHaveLength(1)
  })

  test("a stream that produced text and then closes is NOT an error", async () => {
    const text = interaction(1, encString(1, "hello"))
    const events = await collect(
      translateCursorBidiEnvelopes(fromFrames([env(text)]), { modelId: "cursor-auto" }),
    )
    const types = events.map((e) => e.type)
    expect(types).not.toContain("stream_error")
    expect(types).toContain("text_delta")
    expect(types.at(-1)).toBe("message_stop")
  })

  test("a normal turn_ended stream is unchanged", async () => {
    const payload = concat(interaction(1, encString(1, "ok")), interaction(14))
    const events = await collect(
      translateCursorBidiEnvelopes(fromFrames([env(payload)]), { modelId: "cursor-auto" }),
    )
    const types = events.map((e) => e.type)
    expect(types).not.toContain("stream_error")
    expect(types.filter((t) => t === "message_stop")).toHaveLength(1)
  })
})
