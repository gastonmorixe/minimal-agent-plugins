/**
 * Net-seam characterization: the OpenAI adapter takes its `NetworkClient`
 * from the run context (`ctx.networkClient`), NOT from a module-level import
 * of the host's `defaultNetworkClient` singleton.
 *
 * Wave D (net seam): the host owns the network singleton and threads it into
 * `RunContext.networkClient` (see `src/llm/run.ts`). A provider plugin must be
 * able to live in its own repo, so it cannot import the host's
 * `defaultNetworkClient` from `src/network` as a fallback. The client crosses
 * the provider port, typed by the leaf contract net-types module.
 *
 * Two cases:
 *   1. (positive) an injected fake client is the one actually called, and the
 *      adapter streams its response through the translators — proof the seam
 *      works end to end with a leaf-typed client.
 *   2. (guard / red-first) with NO `ctx.networkClient` the adapter throws a
 *      clear error instead of silently reaching for a global. This FAILS while
 *      the adapter still falls back to `defaultNetworkClient`; it passes once
 *      the fallback is removed and the seam is the sole path.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequestInput,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { openaiAdapter } from "./adapter.ts"
import { fixture } from "./openai.test-helpers.ts"
import { CHAT_COMPLETIONS_URL } from "./wire-constants.ts"

// The adapter's run() argument types, pulled structurally from the local
// adapter export so this test imports NOTHING from src/ (stays leaf-clean).
type RunArgs = Parameters<typeof openaiAdapter.run>
type RunReq = RunArgs[0]
type RunModel = RunArgs[1]

/** A minimal gpt-4o-class Chat model entry, structurally sufficient for run(). */
const fakeChatModel = {
  id: "gpt-4o",
  providerId: "openai",
  surfaceId: "openai-chat-completions",
  displayName: "GPT-4o (fake)",
  capabilities: {
    effort: { levels: [] as string[] },
    maxOutputTokens: 4096,
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsSeed: false,
    acceptsStopSequences: true,
  },
  vendorIds: { firstParty: "gpt-4o" },
} as unknown as RunModel

const fakeReq = {
  modelId: "gpt-4o",
  messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  stream: true,
} as unknown as RunReq

const auth: ProviderAuth = { kind: "api-key", key: "sk-test" }

/** A one-chunk SSE body for the Chat translator: a "pong" + final usage. */
function chatPongStream(): ReadableStream<Uint8Array> {
  const raw =
    'data: {"choices":[{"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
    "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Fake NetworkClient (leaf-typed) that records calls and returns a pong. */
function makeFakeClient(): { client: NetworkClient; calls: NetworkRequestInput[] } {
  const calls: NetworkRequestInput[] = []
  const client: NetworkClient = {
    request(input: NetworkRequestInput): Promise<NetworkResponse> {
      calls.push(input)
      const res: NetworkResponse = {
        status: 200,
        headers: new Headers(),
        body: chatPongStream(),
        transport: { id: "fake" },
        ok: true,
        text: () => Promise.resolve(""),
        json: <T = unknown>() => Promise.resolve(undefined as unknown as T),
      }
      return Promise.resolve(res)
    },
  }
  return { client, calls }
}

async function drain(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

describe("OpenAI adapter — network client comes from ctx (net seam)", () => {
  it("uses the injected ctx.networkClient and streams its response", async () => {
    const { client, calls } = makeFakeClient()
    const events = await drain(
      openaiAdapter.run(fakeReq, fakeChatModel, {
        auth,
        sessionId: "",
        networkClient: client,
      }),
    )
    // The fake was the client actually called (not a global).
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(CHAT_COMPLETIONS_URL)
    expect(calls[0]?.method).toBe("POST")
    // And its body streamed through the translator into canonical events.
    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("pong")
  })

  it("throws a clear error when ctx.networkClient is absent (no silent global fallback)", async () => {
    await expect(
      drain(
        openaiAdapter.run(fakeReq, fakeChatModel, {
          auth,
          sessionId: "",
          // networkClient intentionally omitted
        }),
      ),
    ).rejects.toThrow(/networkClient/i)
  })
})

/** A minimal Responses model entry, structurally sufficient for run(). */
const fakeResponsesModel = {
  ...(fakeChatModel as unknown as Record<string, unknown>),
  id: "gpt-5",
  surfaceId: "openai-responses",
  vendorIds: { firstParty: "gpt-5" },
} as unknown as RunModel

/**
 * Fake client that serves `raw` in small chunks and records every byte the
 * adapter reads, the way a host network observer sees the wire.
 */
function makeTappedClient(raw: string): { client: NetworkClient; seen: () => string } {
  const bytes = new TextEncoder().encode(raw)
  const seenChunks: Uint8Array[] = []
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      // 7 bytes per chunk also splits the 3-byte marker characters.
      const chunk = bytes.slice(offset, offset + 7)
      offset += chunk.length
      seenChunks.push(chunk)
      controller.enqueue(chunk)
    },
  })
  const client: NetworkClient = {
    request(): Promise<NetworkResponse> {
      const res: NetworkResponse = {
        status: 200,
        headers: new Headers(),
        body,
        transport: { id: "fake" },
        ok: true,
        text: () => Promise.resolve(""),
        json: <T = unknown>() => Promise.resolve(undefined as unknown as T),
      }
      return Promise.resolve(res)
    },
  }
  const seen = () => new TextDecoder().decode(Buffer.concat(seenChunks))
  return { client, seen }
}

describe("OpenAI adapter — citation markers (Responses surface)", () => {
  it("strips the marker from canonical text and leaves the wire bytes raw", async () => {
    const raw = fixture("responses-citation-marker.sse")
    const { client, seen } = makeTappedClient(raw)
    const events = await drain(
      openaiAdapter.run(fakeReq, fakeResponsesModel, {
        auth,
        sessionId: "",
        networkClient: client,
      }),
    )

    // The wire side is untouched: every byte, markers included.
    expect(seen()).toBe(raw)
    expect(seen()).toContain("\uE200cite\uE202turn0search0\uE202turn0search1\uE201")

    // The canonical side carries no marker, in deltas or in finalText.
    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("The project has a public site.")
    expect(JSON.stringify(events)).not.toMatch(/[\uE200-\uE202]/)
    expect(events.at(-1)?.type).toBe("message_stop")
  })
})
