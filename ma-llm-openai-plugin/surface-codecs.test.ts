/**
 * OpenAI surface-codec tests.
 *
 * The generic endpoint provider consumes `openAIChatCompletionsCodec`. These
 * tests confirm the codec builds the same Chat Completions body as the direct
 * helper and translates the shared chat SSE fixture into canonical events.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { buildOpenAIChatBody } from "./chat/request-body.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { defaultCapabilities } from "./lib/capabilities.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import { openAIChatCompletionsCodec } from "./surface-codecs.ts"

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "__fixtures__", name), "utf-8")
}

function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

const MODEL: ModelEntry = {
  id: "local-model",
  providerId: "generic-endpoint",
  surfaceId: "openai-chat-completions",
  displayName: "local-model",
  capabilities: defaultCapabilities(),
  pricing: {
    inputUSD: 0,
    outputUSD: 0,
    cacheWriteUSD: 0,
    cacheReadUSD: 0,
    webSearchPerCallUSD: 0,
  },
  vendorIds: { firstParty: "wire-model" },
}

const AUTH: ProviderAuth = { kind: "api-key", key: "sk-test" }
const CTX = { auth: AUTH, sessionId: "" } as RunContext

describe("openAIChatCompletionsCodec", () => {
  it("declares the chat-completions surface and default path", () => {
    expect(openAIChatCompletionsCodec.surfaceId).toBe("openai-chat-completions")
    expect(openAIChatCompletionsCodec.defaultPath).toBe("/v1/chat/completions")
  })

  it("builds the same body as buildOpenAIChatBody and sets the endpoint URL + Bearer auth", () => {
    const req: CanonicalRequest = { modelId: "local-model", messages: [userText("hi")] }
    const request = openAIChatCompletionsCodec.buildRequest({
      req,
      model: MODEL,
      auth: AUTH,
      endpoint: "http://localhost:1234/v1/chat/completions",
      ctx: CTX,
    })
    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://localhost:1234/v1/chat/completions")
    expect(request.headers?.authorization).toBe("Bearer sk-test")
    expect(JSON.parse(request.body as string)).toEqual(buildOpenAIChatBody(req, MODEL))
    // The wire model id comes from vendorIds.firstParty.
    expect(JSON.parse(request.body as string).model).toBe("wire-model")
  })

  it("translates the chat SSE fixture into canonical events", async () => {
    const events: CanonicalEvent[] = []
    const response = { headers: new Headers() } as NetworkResponse
    const req: CanonicalRequest = { modelId: "local-model", messages: [] }
    for await (const ev of openAIChatCompletionsCodec.translateStream({
      body: sseStream(fixture("chat-pong.sse")),
      response,
      req,
      model: MODEL,
      ctx: CTX,
    })) {
      events.push(ev)
    }
    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("pong")
    expect(events.at(-1)?.type).toBe("message_stop")
  })

  it("classifies a 429 as a retryable error", () => {
    const err = openAIChatCompletionsCodec.classifyError?.(
      429,
      JSON.stringify({ error: { type: "rate_limit_error" } }),
    )
    expect(err?.streamErrorType).toBeDefined()
  })
})
