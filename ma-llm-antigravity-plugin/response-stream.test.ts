/**
 * Tests of the Gemini SSE to canonical event translator.
 *
 * Each fixture is a hand-built frame sequence of the real wire shapes, with
 * the signature values replaced by readable placeholders. The rules under
 * test come from the capture survey in
 * `research/2026-11-25-antigravity-plugin/notes/wire.md` 4.3 and 4.4.
 *
 * @module response-stream.test
 */

import { readFileSync } from "node:fs"

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"

import { type GeminiSseFrame, translateAntigravityStream } from "./response-stream.ts"

/** Read a fixture and parse its `data:` frames. */
function frames(name: string): GeminiSseFrame[] {
  const text = readFileSync(`${import.meta.dir}/__fixtures__/${name}`, "utf8")
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as GeminiSseFrame)
}

/** Collect every event of a fixture. */
async function collect(
  name: string,
  opts: { signatureSink?: (id: string, sig: string) => void; mintId?: () => string } = {},
): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  const source = (async function* () {
    yield* frames(name)
  })()
  for await (const ev of translateAntigravityStream(source, {
    modelId: "gemini-4-neon",
    ...opts,
  })) {
    out.push(ev)
  }
  return out
}

function types(events: CanonicalEvent[]): string[] {
  return events.map((ev) => ev.type)
}

describe("translateAntigravityStream text", () => {
  it("emits one text block, a delta per part, and the end of the message", async () => {
    const events = await collect("stream-pong.sse")
    expect(types(events)).toEqual([
      "message_start",
      "text_start",
      "text_delta",
      "text_stop",
      "message_delta",
      "message_stop",
    ])
    const delta = events.find((ev) => ev.type === "text_delta")
    expect(delta).toMatchObject({ text: "pong", index: 0 })
  })

  it("ends with stop reason end_turn and the usage of the last frame", async () => {
    const events = await collect("stream-pong.sse")
    const final = events.find((ev) => ev.type === "message_delta")
    expect(final).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 1 },
    })
  })

  it("includes the responseId in message_start", async () => {
    const events = await collect("stream-pong.sse")
    expect(events[0]).toMatchObject({ type: "message_start", messageId: "resp_pong_1" })
  })
})

describe("translateAntigravityStream thinking", () => {
  it("opens a thinking block before the text block", async () => {
    const events = await collect("stream-thinking-text.sse")
    const order = types(events)
    expect(order.indexOf("thinking_start")).toBeLessThan(order.indexOf("text_start"))
    expect(order.indexOf("thinking_stop")).toBeLessThan(order.indexOf("text_delta"))
  })

  it("keeps the thinking text and the answer text in their own blocks", async () => {
    const events = await collect("stream-thinking-text.sse")
    const think = events.find((ev) => ev.type === "thinking_delta")
    const text = events.find((ev) => ev.type === "text_delta")
    expect(think).toMatchObject({ text: "Let me count." })
    expect(text).toMatchObject({ text: "Four." })
  })

  it("treats an empty text part as a no-op, so a signature carrier adds no block", async () => {
    const events = await collect("stream-thinking-text.sse")
    const textStarts = events.filter((ev) => ev.type === "text_start")
    expect(textStarts).toHaveLength(1)
  })

  it("reports reasoning tokens from thoughtsTokenCount", async () => {
    const events = await collect("stream-thinking-text.sse")
    const final = events.find((ev) => ev.type === "message_delta")
    expect(final).toMatchObject({ usage: { reasoningTokens: 10 } })
  })
})

describe("translateAntigravityStream tool calls", () => {
  it("emits start, one whole-args delta and stop for a single call", async () => {
    const events = await collect("stream-tool-single.sse")
    const toolEvents = events.filter((ev) => ev.type.startsWith("tool_use"))
    expect(types(toolEvents)).toEqual(["tool_use_start", "tool_use_input_delta", "tool_use_stop"])
    expect(toolEvents[0]).toMatchObject({ id: "call_1000000000000000001", name: "read_file" })
    expect(toolEvents[2]).toMatchObject({ input: { Path: "/repo/README.md" } })
  })

  it("sends the args as one JSON fragment, not a stream of pieces", async () => {
    const events = await collect("stream-tool-single.sse")
    const delta = events.find((ev) => ev.type === "tool_use_input_delta")
    expect(delta).toMatchObject({ partialJson: '{"Path":"/repo/README.md"}' })
  })

  it("sends the signature of a call to signatureSink and emits no thinking block for it", async () => {
    const seen: Array<[string, string]> = []
    const events = await collect("stream-tool-single.sse", {
      signatureSink: (id, sig) => seen.push([id, sig]),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe("call_1000000000000000001")
    expect(seen[0][1].startsWith("SIG_TOOL_")).toBe(true)
    expect(events.some((ev) => ev.type === "thinking_signature")).toBe(false)
  })

  it("emits two calls for a parallel batch and reports stop reason tool_use", async () => {
    const events = await collect("stream-tool-parallel.sse")
    const starts = events.filter((ev) => ev.type === "tool_use_start")
    expect(starts).toHaveLength(2)
    const final = events.find((ev) => ev.type === "message_delta")
    expect(final).toMatchObject({ stopReason: "tool_use" })
  })

  it("gives every parallel call its own index", async () => {
    const events = await collect("stream-tool-parallel.sse")
    const stops = events.filter((ev) => ev.type === "tool_use_stop")
    const indexes = stops.map((ev) => (ev as { index: number }).index)
    expect(new Set(indexes).size).toBe(2)
  })

  it("mints an id when the backend sends a call with none", async () => {
    const events: CanonicalEvent[] = []
    const single: GeminiSseFrame[] = [
      {
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "read_file", args: {} } }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
    ]
    for await (const ev of translateAntigravityStream(
      (async function* () {
        yield* single
      })(),
      { modelId: "gemini-4-neon", mintId: () => "minted_1" },
    )) {
      events.push(ev)
    }
    expect(events.find((ev) => ev.type === "tool_use_start")).toMatchObject({ id: "minted_1" })
  })

  it("gives a fallback id that is unique across streams", async () => {
    const frame: GeminiSseFrame = {
      response: {
        responseId: "resp-same",
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "read_file", args: {} }, thoughtSignature: "SIG" },
                { functionCall: { name: "read_file", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    }
    const ids: string[] = []
    const signed: string[] = []
    for (let turn = 0; turn < 2; turn++) {
      for await (const ev of translateAntigravityStream(
        (async function* () {
          yield frame
        })(),
        { modelId: "gemini-4-neon", signatureSink: (id) => signed.push(id) },
      )) {
        if (ev.type === "tool_use_start") ids.push(ev.id)
      }
    }
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) expect(id).toMatch(/^antigravity_tool_[0-9a-f]{12}_\d+$/)
    // Each turn writes its own signature key, so turn 2 cannot overwrite turn 1.
    expect(new Set(signed).size).toBe(2)
  })
})

describe("translateAntigravityStream usage", () => {
  it("takes the cached prompt tokens out of the input count", async () => {
    const events = await collect("stream-usage-cached.sse")
    const final = events.find((ev) => ev.type === "message_delta")
    expect(final).toMatchObject({
      usage: {
        inputTokens: 37_902 - 35_528,
        cacheReadTokens: 35_528,
        outputTokens: 64,
      },
    })
  })

  it("reports max_tokens when the backend stops at the limit", async () => {
    const events = await collect("stream-max-tokens.sse")
    expect(events.find((ev) => ev.type === "message_delta")).toMatchObject({
      stopReason: "max_tokens",
    })
  })
})

describe("translateAntigravityStream errors", () => {
  it("throws a tagged error for an error frame inside a 200 stream", async () => {
    const bad: GeminiSseFrame[] = [
      { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } },
    ]
    const run = async (): Promise<void> => {
      for await (const _ of translateAntigravityStream(
        (async function* () {
          yield* bad
        })(),
        { modelId: "gemini-4-neon" },
      )) {
        void _
      }
    }
    await expect(run()).rejects.toThrow(/429/)
  })

  it("produces a valid message even when the stream carries no frame", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateAntigravityStream((async function* () {})(), {
      modelId: "gemini-4-neon",
    })) {
      events.push(ev)
    }
    expect(types(events)).toEqual(["message_start", "message_delta", "message_stop"])
  })
})
