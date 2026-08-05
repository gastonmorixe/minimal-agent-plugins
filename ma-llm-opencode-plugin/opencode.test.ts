import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { bootstrapOpencode, opencodeProviderPlugin } from "./adapter.ts"
import {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  readOpencodeApiKey,
} from "./auth.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./lib/anthropic-stream.ts"
import { type CanonicalEvent, isEvent } from "./lib/canonical-events.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import {
  buildOpenAIChatBody,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "./lib/openai-chat.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

// A repo-separated provider resolves from a local test registrar rather than
// the host registry. `setup()` re-registers into a fresh one each call and
// exposes the resolvers the tests use.
let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapOpencode({ models: reg.models, providers: reg.providers })
}
function resolveModel(id: string) {
  return reg.resolveModel(id)
}
function resolveProvider(id: string) {
  return reg.resolveProvider(id)
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

function openaiChatPong(): string {
  return readFileSync(join(import.meta.dir, "__fixtures__/chat-pong.sse"), "utf-8")
}

function openaiResponsesPong(): string {
  return readFileSync(join(import.meta.dir, "__fixtures__/responses-pong.sse"), "utf-8")
}

function anthropicPong(): string {
  return readFileSync(
    join(import.meta.dir, "__fixtures__/conversation-opus48.res-body.sse"),
    "utf-8",
  )
}

// Host-integration its (host run() + NetworkResponse mock) live in a core test;
// this file covers plugin-local wire/registration only.
describe("llm-opencode (triple-surface provider: Chat + Messages + Responses)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(opencodeProviderPlugin.apiKeyAuth).toBe(opencodeApiKeyAuth)
    expect(opencodeProviderPlugin.oauthLogin).toBeUndefined()
  })

  it("declares the OpenCode API-key credential codec", () => {
    expect(opencodeApiKeyAuth.serviceId).toBe(OPENCODE_API_KEY_AUTH.serviceId)
    expect(opencodeApiKeyAuth.displayName).toBe("OpenCode Go API Key")

    const write = buildOpencodeApiKeyCredential("og-test-key")
    expect(write).toEqual({
      serviceId: "opencode-api-key",
      displayName: "OpenCode Go API Key",
      secrets: { tokenType: "api-key", apiKey: "og-test-key" },
    })
    expect(readOpencodeApiKey(write.secrets)).toBe("og-test-key")
    expect(readOpencodeApiKey({ tokenType: "api-key" })).toBeNull()
    expect(opencodeApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(opencodeApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers models on all three surfaces", () => {
    setup()

    const chatModel = resolveModel("deepseek-v4-flash")
    expect(chatModel.providerId).toBe("opencode")
    expect(chatModel.surfaceId).toBe("openai-chat-completions")
    expect(chatModel.vendorIds?.firstParty).toBe("deepseek-v4-flash")

    const msgModel = resolveModel("qwen3.8-max")
    expect(msgModel.providerId).toBe("opencode")
    expect(msgModel.surfaceId).toBe("anthropic-messages")
    expect(msgModel.vendorIds?.firstParty).toBe("qwen3.8-max")

    const responsesModel = resolveModel("gpt-5.6-luna")
    expect(responsesModel.providerId).toBe("opencode")
    expect(responsesModel.surfaceId).toBe("openai-responses")
    expect(responsesModel.vendorIds?.firstParty).toBe("gpt-5.6-luna")

    const adapter = resolveProvider("opencode")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("anthropic-messages")
    expect(adapter.surfaces).toContain("openai-responses")
    expect(adapter.displayName).toBe("OpenCode Go")
  })

  it("registers all known model IDs", () => {
    setup()
    // Live /v1/models snapshot 2026-08-05 (authoritative ID list).
    const ids = [
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "gpt-5.6-luna",
      "qwen3.8-max",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "hy3",
      "hy3-preview",
      "grok-4.5",
    ]
    for (const id of ids) {
      const m = resolveModel(id)
      expect(m.providerId).toBe("opencode")
    }
  })

  it("applies models.dev caps and docs/go pricing (2026-08-05)", () => {
    setup()
    // Caps refreshed from models.dev where they previously drifted.
    expect(resolveModel("glm-5").capabilities.contextWindow).toBe(202_752)
    expect(resolveModel("glm-5").capabilities.maxOutputTokens).toBe(32_768)
    expect(resolveModel("glm-5.1").capabilities.maxOutputTokens).toBe(32_768)
    expect(resolveModel("kimi-k2.7-code").capabilities.maxOutputTokens).toBe(262_144)
    expect(resolveModel("minimax-m2.5").capabilities.maxOutputTokens).toBe(65_536)
    expect(resolveModel("grok-4.5").capabilities.maxOutputTokens).toBe(500_000)
    // hy3-preview clones hy3 (no secondary source for distinct caps).
    expect(resolveModel("hy3-preview").capabilities.contextWindow).toBe(
      resolveModel("hy3").capabilities.contextWindow,
    )
    // Docs/go wins over models.dev on grok cache_read ($0.30 vs $0.50).
    expect(resolveModel("grok-4.5").pricing?.cacheReadUSD).toBe(0.3)
    expect(resolveModel("minimax-m2.7").pricing?.cacheWriteUSD).toBe(0.375)

    // New 2026-08-05 models.
    const luna = resolveModel("gpt-5.6-luna")
    expect(luna.surfaceId).toBe("openai-responses")
    expect(luna.capabilities.contextWindow).toBe(1_050_000)
    expect(luna.capabilities.maxOutputTokens).toBe(128_000)
    expect(luna.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: true,
      video: false,
    })
    expect(luna.capabilities.acceptsTemperature).toBe(false)
    expect([...luna.capabilities.effort.levels]).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    // Docs/go ≤272K wins over models.dev base rates.
    expect(luna.pricing?.inputUSD).toBe(0.2)
    expect(luna.pricing?.outputUSD).toBe(1.2)
    expect(luna.pricing?.cacheReadUSD).toBe(0.02)
    expect(luna.pricing?.cacheWriteUSD).toBe(0.25)

    const qwen38 = resolveModel("qwen3.8-max")
    expect(qwen38.surfaceId).toBe("anthropic-messages")
    expect(qwen38.capabilities.contextWindow).toBe(1_000_000)
    expect(qwen38.capabilities.maxOutputTokens).toBe(131_072)
    expect(qwen38.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: false,
      video: true,
    })
    expect(qwen38.pricing?.inputUSD).toBe(2.0)
    expect(qwen38.pricing?.outputUSD).toBe(6.0)
    expect(qwen38.pricing?.cacheReadUSD).toBe(0.25)
    expect(qwen38.pricing?.cacheWriteUSD).toBe(2.5)

    // deepseek-v4-flash effort ladder synced to models.dev.
    expect([...resolveModel("deepseek-v4-flash").capabilities.effort.levels]).toEqual([
      "low",
      "high",
      "max",
    ])
  })

  it("registers ad-hoc slugs on demand", () => {
    setup()
    opencodeProviderPlugin.registerAdHocModel?.("deepseek-v4-ultra")
    const m = resolveModel("deepseek-v4-ultra")
    expect(m.providerId).toBe("opencode")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.displayName).toBe("deepseek-v4-ultra")
  })

  it("round-trips a Chat stream through the REUSED OpenAI translator", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateOpenAIChatStream(
      parseSse<OpenAIChatChunk>(sseStream(openaiChatPong())),
    )) {
      events.push(ev)
    }
    let text = ""
    for (const ev of events) if (isEvent(ev, "text_delta")) text += ev.text
    expect(text).toBe("pong")
  })

  it("round-trips a Responses stream through the REUSED OpenAI translator", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateOpenAIResponsesStream(
      parseSse<OpenAIResponsesEvent>(sseStream(openaiResponsesPong())),
    )) {
      events.push(ev)
    }
    let text = ""
    for (const ev of events) if (isEvent(ev, "text_delta")) text += ev.text
    expect(text.length).toBeGreaterThan(0)
  })

  it("round-trips a Messages stream through the REUSED Anthropic translator", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(
      parseSse<AnthropicStreamEvent>(sseStream(anthropicPong())),
    )) {
      events.push(ev)
    }
    let text = ""
    for (const ev of events) if (isEvent(ev, "text_delta")) text += ev.text
    expect(text).toMatch(/I'm Opus/)
  })

  it("validates a plain Chat request via the REUSED OpenAI validator", () => {
    setup()
    const adapter = resolveProvider("opencode")
    const req: CanonicalRequest = { modelId: "deepseek-v4-flash", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("deepseek-v4-flash")).ok).toBe(true)
  })

  it("validates a plain Messages request via the REUSED Anthropic validator", () => {
    setup()
    const adapter = resolveProvider("opencode")
    const req: CanonicalRequest = { modelId: "qwen3.8-max", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("qwen3.8-max")).ok).toBe(true)
  })

  it("validates a plain Responses request and rejects temperature on Luna", () => {
    setup()
    const adapter = resolveProvider("opencode")
    const model = resolveModel("gpt-5.6-luna")
    const ok: CanonicalRequest = { modelId: "gpt-5.6-luna", messages: [userText("hi")] }
    expect(adapter.validate(ok, model).ok).toBe(true)

    const bad: CanonicalRequest = {
      modelId: "gpt-5.6-luna",
      messages: [userText("hi")],
      generation: { temperature: 0.7 },
    }
    expect(adapter.validate(bad, model).ok).toBe(false)
  })

  it("rejects missing API key on run", async () => {
    setup()
    const adapter = resolveProvider("opencode")
    const model = resolveModel("deepseek-v4-flash")
    const req: CanonicalRequest = { modelId: "deepseek-v4-flash", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "" },
      sessionId: "test",
    }
    await expect(async () => {
      for await (const _ of adapter.run(req, model, ctx)) {
        // should throw before yielding
      }
    }).toThrow("missing api-key")
  })

  it("emits tool_result blocks as role:tool messages (not silently dropped)", () => {
    setup()
    const model = resolveModel("deepseek-v4-flash")
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "which model are you?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_abc123",
              name: "ModelInfo",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_abc123",
              content: [
                {
                  type: "text",
                  text: '{"id":"deepseek-v4-flash","displayName":"DeepSeek V4 Flash"}',
                },
              ],
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    }
    const body = buildOpenAIChatBody(req, model)
    const toolMessages = body.messages.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.tool_call_id).toBe("call_abc123")
    expect(toolMessages[0]!.content).toContain("deepseek-v4-flash")
    // Verify the message ordering: user → assistant (with tool_calls) → tool → user
    const roles = body.messages.map((m) => m.role)
    const toolIdx = roles.indexOf("tool")
    expect(toolIdx).toBeGreaterThan(roles.indexOf("assistant"))
  })

  const KEY = process.env.MINIMAL_AGENT_OPENCODE_LIVE_KEY
  it.skipIf(!KEY)(
    "live: deepseek-v4-flash via OpenCode Go (auth + wire reach the API)",
    async () => {
      setup()
      const model = resolveModel("deepseek-v4-flash")
      const provider = resolveProvider("opencode")
      const req: CanonicalRequest = {
        modelId: "deepseek-v4-flash",
        messages: [userText("Reply with the single word: pong")],
        generation: { maxOutputTokens: 512 },
      }
      const ctx: RunContext = {
        auth: { kind: "api-key", key: KEY as string },
        sessionId: "opencode-live-test",
      }
      let text = ""
      try {
        for await (const ev of provider.run(req, model, ctx)) {
          if (isEvent(ev, "text_delta")) text += ev.text
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(msg).toMatch(
          /\b401\b|\b402\b|\b403\b|insufficient credits|user not found|unauthorized/i,
        )
        return
      }
      expect(text.length).toBeGreaterThan(0)
    },
  )
})
