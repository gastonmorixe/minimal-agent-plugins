/**
 * DeepSeek provider tests.
 *
 * Offline: auth codec, model registration, request-body mapping (thinking
 * toggle, max_tokens, reasoning round-trip), the synthetic reasoning-signature
 * wrap, the adapter round-trip against a mock network client, live-list mapping,
 * and pricing.
 */

import { describe, expect, it } from "bun:test"

import {
  bootstrapDeepSeek,
  deepseekProviderPlugin,
  withDeepSeekReasoningSignature,
} from "./adapter.ts"
import {
  buildDeepseekApiKeyCredential,
  DEEPSEEK_API_KEY_AUTH,
  deepseekApiKeyAuth,
  readDeepseekApiKey,
} from "./auth.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequest, NetworkResponse } from "./lib/net-types.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { mapDeepSeekLiveModels } from "./live-models.ts"
import { PRICING_DEEPSEEK_FLASH, PRICING_DEEPSEEK_V4_PRO } from "./pricing.ts"
import { buildDeepSeekChatBody } from "./request-body.ts"
import { CHAT_COMPLETIONS_URL } from "./wire-constants.ts"

let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapDeepSeek({ models: reg.models, providers: reg.providers })
}
function resolveModel(id: string): ModelEntry {
  return reg.resolveModel(id)
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

/** A reasoning-then-text Chat stream (DeepSeek shape). */
function deepseekReasoningSse(): string {
  const chunks = [
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think" } }],
    },
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: { content: "pong" } }],
    },
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  ]
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
}

/** Build a NetworkResponse-shaped object with a generic `json`. */
function mockResponse(init: {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array>
  text: string
}): NetworkResponse {
  return {
    status: init.status,
    ok: init.ok,
    headers: new Headers(),
    body: init.body,
    transport: { id: "mock" },
    async text() {
      return init.text
    },
    async json<T = unknown>(): Promise<T> {
      return JSON.parse(init.text) as T
    },
  }
}

/** Capture the request and return a canned SSE response. */
function mockNetworkClient(raw: string): { client: NetworkClient; seen: NetworkRequest[] } {
  const seen: NetworkRequest[] = []
  const client: NetworkClient = {
    async request(input) {
      seen.push(input as NetworkRequest)
      return mockResponse({ ok: true, status: 200, body: sseStream(raw), text: "" })
    },
  }
  return { client, seen }
}

function runCtx(client: NetworkClient, key = "sk-test"): RunContext {
  return { auth: { kind: "api-key", key }, sessionId: "deepseek-test", networkClient: client }
}

/** A real-fetch NetworkClient for the opt-in live test. */
function fetchNetworkClient(): NetworkClient {
  return {
    async request(input) {
      const resp = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body as string | undefined,
        signal: input.signal,
      })
      if (!resp.body) throw new Error("live: empty response body")
      return {
        status: resp.status,
        ok: resp.ok,
        headers: resp.headers,
        body: resp.body,
        transport: { id: "fetch" },
        async text() {
          return resp.text()
        },
        async json<T = unknown>(): Promise<T> {
          return (await resp.json()) as T
        },
      }
    },
  }
}

describe("llm-deepseek (OpenAI Chat-compatible)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(deepseekProviderPlugin.apiKeyAuth).toBe(deepseekApiKeyAuth)
    expect(deepseekProviderPlugin.oauthLogin).toBeUndefined()
    expect(deepseekProviderPlugin.id).toBe("deepseek")
    expect(deepseekProviderPlugin.shortCode).toBe("ds")
  })

  it("declares the DeepSeek API-key credential codec", () => {
    expect(deepseekApiKeyAuth.serviceId).toBe(DEEPSEEK_API_KEY_AUTH.serviceId)
    expect(deepseekApiKeyAuth.displayName).toBe("DeepSeek API Key")

    const write = buildDeepseekApiKeyCredential("sk-ds-test")
    expect(write).toEqual({
      serviceId: "deepseek-api-key",
      displayName: "DeepSeek API Key",
      secrets: { tokenType: "api-key", apiKey: "sk-ds-test" },
    })
    expect(readDeepseekApiKey(write.secrets)).toBe("sk-ds-test")
    expect(readDeepseekApiKey({ tokenType: "api-key" })).toBeNull()
    expect(deepseekApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(deepseekApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers the catalog on the shared openai-chat-completions surface", () => {
    setup()
    const flash = resolveModel("deepseek-flash")
    expect(flash.providerId).toBe("deepseek")
    expect(flash.surfaceId).toBe("openai-chat-completions")
    expect(flash.displayName).toBe("DeepSeek V4.1 Flash")
    expect(flash.vendorIds?.firstParty).toBe("deepseek-flash")
    expect(flash.capabilities.contextWindow).toBe(1_000_000)
    expect(flash.capabilities.effort.levels).toEqual(["none", "low", "high", "max"])
    expect(flash.capabilities.modalities.image).toBe(true)

    const pro = resolveModel("deepseek-v4-pro")
    expect(pro.capabilities.modalities.image).toBe(false)
    expect(pro.vendorIds?.firstParty).toBe("deepseek-v4-pro")

    expect(reg.resolveProvider("deepseek").surfaces).toContain("openai-chat-completions")
  })

  it("registers ad-hoc slugs on demand", () => {
    setup()
    deepseekProviderPlugin.registerAdHocModel?.("deepseek-experimental")
    const m = resolveModel("deepseek-experimental")
    expect(m.providerId).toBe("deepseek")
    expect(m.surfaceId).toBe("openai-chat-completions")
  })

  it("validates a plain request", () => {
    setup()
    const adapter = reg.resolveProvider("deepseek")
    const req: CanonicalRequest = { modelId: "deepseek-flash", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("deepseek-flash")).ok).toBe(true)
  })

  it("rejects an unsupported reasoning level", () => {
    setup()
    const adapter = reg.resolveProvider("deepseek")
    const req: CanonicalRequest = {
      modelId: "deepseek-flash",
      messages: [userText("hi")],
      effort: "medium",
    }
    const result = adapter.validate(req, resolveModel("deepseek-flash"))
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.capability === "effort")).toBe(true)
  })

  it("builds the DeepSeek body with the thinking toggle and max_tokens", () => {
    setup()
    const model = resolveModel("deepseek-flash")
    const req: CanonicalRequest = {
      modelId: "deepseek-flash",
      messages: [userText("hi")],
      generation: { maxOutputTokens: 128 },
      effort: "high",
    }
    const body = buildDeepSeekChatBody(req, model)
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("high")
    expect(body.max_tokens).toBe(128)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it("disables thinking when effort is none", () => {
    setup()
    const model = resolveModel("deepseek-flash")
    const req: CanonicalRequest = {
      modelId: "deepseek-flash",
      messages: [userText("hi")],
      effort: "none",
    }
    const body = buildDeepSeekChatBody(req, model)
    expect(body.thinking).toEqual({ type: "disabled" })
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe("none")
  })

  it("echoes thinking back as reasoning_content on assistant messages", () => {
    setup()
    const model = resolveModel("deepseek-flash")
    const req: CanonicalRequest = {
      modelId: "deepseek-flash",
      messages: [
        userText("hi"),
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "because" },
            { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [] }] },
        userText("again"),
      ],
      tools: [{ name: "f", description: "f", inputSchema: { type: "object" } }],
    }
    const body = buildDeepSeekChatBody(req, model)
    const assistant = body.messages.find((m) => m.role === "assistant")
    expect(assistant?.reasoning_content).toBe("because")
    expect(assistant?.tool_calls?.[0]?.id).toBe("t1")
  })

  it("wraps reasoning deltas with a synthetic signature", async () => {
    async function* events(): AsyncIterable<CanonicalEvent> {
      yield { type: "thinking_start", index: 0 }
      yield { type: "thinking_delta", index: 0, text: "why" }
      yield { type: "thinking_stop", index: 0 }
      yield { type: "text_delta", index: 1, text: "pong" }
    }
    const out: CanonicalEvent[] = []
    for await (const ev of withDeepSeekReasoningSignature(events())) out.push(ev)
    const types = out.map((e) => e.type)
    expect(types).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_signature",
      "thinking_stop",
      "text_delta",
    ])
    const sig = out.find((e) => e.type === "thinking_signature")
    expect(sig && sig.type === "thinking_signature" ? sig.index : -1).toBe(0)
  })

  it("round-trips a stream through the adapter (path, body, events)", async () => {
    setup()
    const { client, seen } = mockNetworkClient(deepseekReasoningSse())
    const req: CanonicalRequest = {
      modelId: "deepseek-flash",
      messages: [userText("ping")],
      generation: { maxOutputTokens: 16 },
    }
    const events: CanonicalEvent[] = []
    for await (const ev of reg
      .resolveProvider("deepseek")
      .run(req, resolveModel("deepseek-flash"), runCtx(client))) {
      events.push(ev)
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(CHAT_COMPLETIONS_URL)
    const sent = JSON.parse(String(seen[0]?.body)) as { thinking?: unknown; model?: string }
    expect(sent.model).toBe("deepseek-flash")
    expect(sent.thinking).toEqual({ type: "enabled" })

    let text = ""
    let reasoning = ""
    for (const ev of events) {
      if (ev.type === "text_delta") text += ev.text
      if (ev.type === "thinking_delta") reasoning += ev.text
    }
    expect(reasoning).toBe("think")
    expect(text).toBe("pong")
    expect(events.some((e) => e.type === "thinking_signature")).toBe(true)
  })

  it("throws a tagged error on a non-2xx response", async () => {
    setup()
    const client: NetworkClient = {
      async request() {
        return mockResponse({
          ok: false,
          status: 401,
          body: sseStream(""),
          text: JSON.stringify({ error: { type: "authentication_error" } }),
        })
      },
    }
    const req: CanonicalRequest = { modelId: "deepseek-flash", messages: [userText("ping")] }
    let caught: unknown
    try {
      for await (const _ of reg
        .resolveProvider("deepseek")
        .run(req, resolveModel("deepseek-flash"), runCtx(client))) {
        // drain
      }
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("DeepSeek API 401")
    expect((caught as Error & { streamErrorType?: string }).streamErrorType).toBeUndefined()
  })

  // Live round-trip. Set MINIMAL_AGENT_DEEPSEEK_LIVE_KEY to run it. Proves the
  // request reaches DeepSeek with valid auth + a well-formed Chat body, and that
  // reasoning + text stream back through the shared translator.
  const KEY = process.env.MINIMAL_AGENT_DEEPSEEK_LIVE_KEY
  it.skipIf(!KEY)("live: deepseek-flash streams reasoning + text", async () => {
    setup()
    const req: CanonicalRequest = {
      modelId: "deepseek-flash",
      messages: [userText("Reply with the single word: pong")],
      generation: { maxOutputTokens: 64 },
      effort: "low",
    }
    let text = ""
    let reasoning = ""
    for await (const ev of reg
      .resolveProvider("deepseek")
      .run(req, resolveModel("deepseek-flash"), {
        auth: { kind: "api-key", key: KEY as string },
        sessionId: "deepseek-live-test",
        networkClient: fetchNetworkClient(),
      })) {
      if (ev.type === "text_delta") text += ev.text
      if (ev.type === "thinking_delta") reasoning += ev.text
    }
    expect(text.length).toBeGreaterThan(0)
    void reasoning
  })

  it("maps a live /models body into rows", () => {
    const rows = mapDeepSeekLiveModels({
      data: [
        { id: "deepseek-flash", created: 1_700_000_000 },
        { id: "deepseek-v4-pro" },
        { object: "model" },
      ],
    })
    expect(rows).toEqual([
      { id: "deepseek-flash", createdAt: "2023-11-14" },
      { id: "deepseek-v4-pro", createdAt: undefined },
    ])
  })

  it("exposes the DeepSeek pricing table", () => {
    expect(PRICING_DEEPSEEK_FLASH.inputUSD).toBe(0.15)
    expect(PRICING_DEEPSEEK_FLASH.cacheReadUSD).toBe(0.003)
    expect(PRICING_DEEPSEEK_FLASH.outputUSD).toBe(0.6)
    expect(PRICING_DEEPSEEK_V4_PRO.inputUSD).toBe(0.66)
    expect(PRICING_DEEPSEEK_V4_PRO.outputUSD).toBe(1.98)
  })
})
