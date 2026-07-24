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

const ZERO_PRICING = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
} as const

function baseModel(
  over: Partial<{
    id: string
    tags: string[]
    vendorIds: Record<string, string>
    capabilities: ReturnType<typeof cursorCaps>
  }> = {},
) {
  return {
    id: over.id ?? "cursor-composer-2.5-fast",
    providerId: "cursor",
    surfaceId: CURSOR_SURFACE_AGENT_RUN,
    displayName: "Composer 2.5 Fast (Cursor)",
    capabilities: over.capabilities ?? cursorCaps({ thinking: true }),
    pricing: ZERO_PRICING,
    tags: over.tags,
    vendorIds: over.vendorIds ?? { cursor: "composer-2.5-fast", firstParty: "composer-2.5-fast" },
  }
}

function runRequestFields(body: Uint8Array) {
  const outer = decodeFields(body)
  const run = fieldBytes(outer.find((f) => f.no === 1)!)
  expect(run).toBeTruthy()
  return decodeFields(run!)
}

function requestedModelFields(body: Uint8Array) {
  const runFields = runRequestFields(body)
  const rm = fieldBytes(runFields.find((f) => f.no === 9)!)
  expect(rm).toBeTruthy()
  return decodeFields(rm!)
}

function modelDetailsFields(body: Uint8Array) {
  const runFields = runRequestFields(body)
  const md = fieldBytes(runFields.find((f) => f.no === 3)!)
  expect(md).toBeTruthy()
  return decodeFields(md!)
}

describe("AgentRunRequest MVP body", () => {
  test("omits AgentRunRequest field 8 (customSystemPrompt) and field 12 (excludeWorkspaceContext)", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        system: [{ type: "text", text: "You are a helpful assistant." }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      baseModel(),
    )
    const nos = new Set(runRequestFields(body).map((f) => f.no))
    expect(nos.has(8)).toBe(false) // customSystemPrompt rejected live
    expect(nos.has(12)).toBe(false) // excludeWorkspaceContext rejected live
    expect(nos.has(2)).toBe(true) // conversation action present
    expect(nos.has(9)).toBe(true) // requested model present
  })

  test("base model: no variant f8; max_mode false on RequestedModel f2; no parameters without effort", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      baseModel({ tags: ["cursor", "live", "thinking", "effort-param:effort"] }),
    )
    const rm = requestedModelFields(body)
    const nos = new Set(rm.map((f) => f.no))
    expect(nos.has(8)).toBe(false) // not a variant
    expect(nos.has(3)).toBe(false) // no req.effort → no parameters
    // f2 max_mode explicit false is present as bool varint 0
    const maxField = rm.find((f) => f.no === 2)
    expect(maxField).toBeTruthy()
    expect(maxField!.wire).toBe(0)
    expect(maxField!.value).toBe(0)
  })

  test("explicit effort encodes RequestedModel.parameters f3 with effort-param tag id", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        effort: "high",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      baseModel({
        tags: ["cursor", "live", "thinking", "effort-param:reasoning_effort"],
        capabilities: cursorCaps({
          thinking: true,
          effortLevels: ["low", "medium", "high", "max"],
        }),
      }),
    )
    const rm = requestedModelFields(body)
    const paramMsgs = rm.filter((f) => f.no === 3)
    expect(paramMsgs.length).toBe(1)
    const pv = decodeFields(fieldBytes(paramMsgs[0]!)!)
    expect(pv.find((f) => f.no === 1 && f.wire === 2)).toBeTruthy()
    // id string
    const idBytes = fieldBytes(pv.find((f) => f.no === 1)!)
    const valBytes = fieldBytes(pv.find((f) => f.no === 2)!)
    expect(new TextDecoder().decode(idBytes!)).toBe("reasoning_effort")
    expect(new TextDecoder().decode(valBytes!)).toBe("high")
  })

  test("effort omitted when effort-param tag missing (no inventing id)", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        effort: "high",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      baseModel({ tags: ["cursor", "live", "thinking"] }),
    )
    const rm = requestedModelFields(body)
    expect(rm.some((f) => f.no === 3)).toBe(false)
  })

  test("variant tag sets RequestedModel f8; max-mode sets f2 and ModelDetails f7", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-high",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      baseModel({
        id: "cursor-composer-high",
        tags: ["cursor", "live", "variant", "parent:composer", "max-mode", "effort-param:effort"],
        vendorIds: { cursor: "composer-high", firstParty: "composer-high" },
      }),
    )
    const rm = requestedModelFields(body)
    const f8 = rm.find((f) => f.no === 8)
    expect(f8).toBeTruthy()
    expect(f8!.value).toBe(1)
    const f2 = rm.find((f) => f.no === 2)
    expect(f2!.value).toBe(1)
    const md = modelDetailsFields(body)
    const mdMax = md.find((f) => f.no === 7)
    expect(mdMax).toBeTruthy()
    expect(mdMax!.value).toBe(1)
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
