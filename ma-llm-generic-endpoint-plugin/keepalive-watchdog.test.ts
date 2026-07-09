/**
 * Regression guard for the oMLX/MLX prefill-keepalive stall.
 *
 * A local OpenAI-compatible server (MLX, vLLM, LM Studio) sends SSE keepalive
 * frames every ~10s during a long prefill before the first content token. The
 * frame is a valid chat chunk with an empty-content assistant delta:
 *
 *   {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
 *
 * The vendored `translateOpenAIChatStream` MUST surface each such frame as a
 * `ping` canonical event. The transport watchdog resets its idle timer on any
 * yielded event, so a swallowed keepalive (the original bug) let the 30s
 * `stream_idle` watchdog fire mid-prefill and abort a healthy request, which
 * then retried forever from scratch.
 *
 * This test pins the fix in THIS plugin's own vendored copy so a future
 * re-vendor that regresses the translator is caught here, not by a user
 * staring at a stalled MLX server.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "./lib/canonical-events.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./lib/openai-chat.ts"

async function* fromChunks(chunks: OpenAIChatChunk[]): AsyncIterable<OpenAIChatChunk> {
  for (const c of chunks) yield c
}

async function collect(stream: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

/** The exact keepalive frame an MLX/oMLX server emits during prefill. */
function keepalive(): OpenAIChatChunk {
  return {
    id: "chatcmpl-keepalive",
    object: "chat.completion.chunk",
    created: 0,
    model: "keepalive",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }
}

function textChunk(id: string, content: string): OpenAIChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }
}

function stopChunk(id: string): OpenAIChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: 2,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }
}

describe("generic-endpoint vendored translator: keepalive → ping (watchdog liveness)", () => {
  it("emits a ping for each empty-delta prefill keepalive chunk", async () => {
    const evs = await collect(
      translateOpenAIChatStream(
        fromChunks([textChunk("c1", "Hi"), keepalive(), keepalive(), stopChunk("c1")]),
      ),
    )
    expect(evs.filter((e) => e.type === "ping").length).toBe(2)

    // Keepalives must not corrupt the content stream: exactly one text delta,
    // no phantom text blocks from the empty `content:""` deltas.
    const textDeltas = evs.filter((e) => e.type === "text_delta") as Array<{ text: string }>
    expect(textDeltas.map((t) => t.text)).toEqual(["Hi"])
  })

  it("emits a ping for a choice-less keepalive/usage chunk", async () => {
    const noChoice: OpenAIChatChunk = {
      id: "chatcmpl-ka",
      object: "chat.completion.chunk",
      created: 0,
      model: "keepalive",
      // no `choices` array at all
    }
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([textChunk("c1", "yo"), noChoice, stopChunk("c1")])),
    )
    expect(evs.filter((e) => e.type === "ping").length).toBe(1)
  })

  it("does not emit a ping when a chunk produces real content", async () => {
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([textChunk("c1", "hello"), stopChunk("c1")])),
    )
    expect(evs.filter((e) => e.type === "ping").length).toBe(0)
  })

  it("still terminates with message_delta + message_stop after keepalives", async () => {
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([keepalive(), keepalive(), stopChunk("c1")])),
    )
    const t = evs.map((e) => e.type)
    expect(t[0]).toBe("message_start")
    expect(t[t.length - 2]).toBe("message_delta")
    expect(t[t.length - 1]).toBe("message_stop")
    expect(evs.filter((e) => e.type === "ping").length).toBe(2)
  })
})
