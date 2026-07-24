/**
 * Offline fixture tests for Connect frame parse + CanonicalEvent mapping.
 */

import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { encodeAgentClientMessageRun, extractServerTextEvents } from "./proto/agent-run.ts"
import { translateCursorStreamBuffer } from "./response-stream.ts"

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
