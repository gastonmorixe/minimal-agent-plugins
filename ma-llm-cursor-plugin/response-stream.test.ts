/**
 * Offline fixture tests for Connect frame parse + CanonicalEvent mapping.
 */

import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { cursorCaps } from "./capabilities.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { encodeAgentClientMessageRun, extractServerTextEvents } from "./proto/agent-run.ts"
import { decodeFields, fieldBytes } from "./proto/wire.ts"
import { buildCursorAgentRunBody } from "./request-body.ts"
import { translateCursorStreamBuffer } from "./response-stream.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

describe("AgentRunRequest MVP body", () => {
  test("omits field 8 (customSystemPrompt) and field 12 (excludeWorkspaceContext)", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        system: [{ type: "text", text: "You are a helpful assistant." }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      {
        id: "cursor-composer-2.5-fast",
        providerId: "cursor",
        surfaceId: CURSOR_SURFACE_AGENT_RUN,
        displayName: "Composer 2.5 Fast (Cursor)",
        capabilities: cursorCaps({ thinking: true }),
        pricing: {
          inputUSD: 0,
          outputUSD: 0,
          cacheWriteUSD: 0,
          cacheReadUSD: 0,
          webSearchPerCallUSD: 0,
        },
        vendorIds: { cursor: "composer-2.5-fast", firstParty: "composer-2.5-fast" },
      },
    )
    // AgentClientMessage field 1 = AgentRunRequest
    const outer = decodeFields(body)
    const run = fieldBytes(outer.find((f) => f.no === 1)!)
    expect(run).toBeTruthy()
    const nos = new Set(decodeFields(run!).map((f) => f.no))
    expect(nos.has(8)).toBe(false) // customSystemPrompt rejected live
    expect(nos.has(12)).toBe(false) // excludeWorkspaceContext rejected live
    expect(nos.has(2)).toBe(true) // conversation action present
    expect(nos.has(9)).toBe(true) // requested model present
  })
})

describe("connect frames", () => {
  test("round-trip frame header", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const framed = connectFrameProto(payload)
    const frames = parseConnectFrames(framed)
    expect(frames.length).toBe(1)
    expect(frames[0]!.endStream).toBe(false)
    expect([...frames[0]!.payload]).toEqual([1, 2, 3, 4])
  })

  test("encode AgentClientMessage is non-empty", () => {
    const body = encodeAgentClientMessageRun({
      text: "say pong",
      modelId: "composer-2.5-fast",
      mode: 2,
    })
    expect(body.length).toBeGreaterThan(10)
    const framed = connectFrameProto(body)
    expect(framed[0]).toBe(0)
    expect(framed.length).toBe(5 + body.length)
  })
})

describe("end-stream trailer → stream_error", () => {
  test("surfaces Connect JSON as Error.cause so host can print message", async () => {
    const trailer = new TextEncoder().encode(
      JSON.stringify({ error: { code: "invalid_argument", message: "bad model id" } }),
    )
    // flags bit1 = end-stream
    const frame = new Uint8Array(5 + trailer.length)
    frame[0] = 0x02
    new DataView(frame.buffer).setUint32(1, trailer.length, false)
    frame.set(trailer, 5)

    const events = []
    for await (const ev of translateCursorStreamBuffer(frame, { modelId: "composer-2.5-fast" })) {
      events.push(ev)
    }
    expect(events).toHaveLength(1)
    const errEv = events[0]!
    expect(errEv.type).toBe("stream_error")
    if (errEv.type !== "stream_error") return
    expect(errEv.category).toBe("api")
    expect(errEv.upstreamType).toBe("invalid_argument")
    expect(errEv.cause).toBeInstanceOf(Error)
    expect((errEv.cause as Error).message).toContain("invalid_argument")
    expect((errEv.cause as Error).message).toContain("bad model id")
  })
})

describe("spike run-resp.bin fixture", () => {
  test("parses frames and emits text_delta events", async () => {
    const path = join(import.meta.dir, "__fixtures__/run-resp.bin")
    const buf = new Uint8Array(await Bun.file(path).arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)

    const frames = parseConnectFrames(buf)
    expect(frames.length).toBeGreaterThan(0)

    const kinds: string[] = []
    for (const f of frames) {
      if (f.endStream) continue
      for (const e of extractServerTextEvents(f.payload)) kinds.push(e.kind)
    }
    expect(
      kinds.some((k) => k === "text_delta" || k === "thinking_delta" || k === "turn_ended"),
    ).toBe(true)

    const events = []
    for await (const ev of translateCursorStreamBuffer(buf, { modelId: "composer-2.5-fast" })) {
      events.push(ev)
    }
    expect(events.some((e) => e.type === "message_start")).toBe(true)
    expect(events.some((e) => e.type === "text_delta" || e.type === "thinking_delta")).toBe(true)
    expect(events.some((e) => e.type === "message_stop")).toBe(true)
  })
})
