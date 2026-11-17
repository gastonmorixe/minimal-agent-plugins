import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  type AnthropicStreamEvent,
  translateAnthropicStream,
} from "@minimal-agent/core/plugin-api/llm/anthropic-stream"
import { type CanonicalEvent, isEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "@minimal-agent/core/plugin-api/llm/openai-chat"
import type { RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient, NetworkRequestInput } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { bootstrapOpencode, opencodeProviderPlugin } from "./adapter.ts"
import {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  readOpencodeApiKey,
} from "./auth.ts"
import { buildAnthropicRequestBody } from "./lib/anthropic-request.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { opencodeConsoleOAuthLogin } from "./oauth-login.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
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

function sseStream(raw: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw
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
  it("exposes API-key auth, Console OAuth, the former id, and no anonymous auth", () => {
    expect(opencodeProviderPlugin.id).toBe("opencode-go")
    expect(opencodeProviderPlugin.shortCode).toBe("og")
    expect(opencodeProviderPlugin.apiKeyAuth).toBe(opencodeApiKeyAuth)
    expect(opencodeProviderPlugin.oauthLogin).toBe(opencodeConsoleOAuthLogin)
    expect(opencodeProviderPlugin.formerIds).toEqual(["opencode"])
    expect(opencodeProviderPlugin.anonymousAuth).toBeUndefined()
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

    const chatModel = resolveModel("deepseek-v4-pro")
    expect(chatModel.providerId).toBe("opencode-go")
    expect(chatModel.surfaceId).toBe("openai-chat-completions")
    expect(chatModel.vendorIds?.firstParty).toBe("deepseek-v4-pro")

    const msgModel = resolveModel("qwen3.8-max")
    expect(msgModel.providerId).toBe("opencode-go")
    expect(msgModel.surfaceId).toBe("anthropic-messages")
    expect(msgModel.vendorIds?.firstParty).toBe("qwen3.8-max")

    const responsesModel = resolveModel("gpt-5.6-luna")
    expect(responsesModel.providerId).toBe("opencode-go")
    expect(responsesModel.surfaceId).toBe("openai-responses")
    expect(responsesModel.vendorIds?.firstParty).toBe("gpt-5.6-luna")

    const adapter = resolveProvider("opencode-go")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("anthropic-messages")
    expect(adapter.surfaces).toContain("openai-responses")
    expect(adapter.displayName).toBe("OpenCode Go")
  })

  it("registers all known model IDs", () => {
    setup()
    // Live /v1/models snapshot 2026-11-15 (authoritative ID list).
    const ids = [
      "beam-free",
      "claude-haiku-5-5",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "gemini-4-argon",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "gpt-6-luna",
      "grok-4.7",
      "hy3",
      "hy4",
      "hy4-preview",
      "iceman-contributor-free",
      "kimi-k2.7-code",
      "kimi-k3",
      "kimi-k3.1-pro",
      "longcat-2.0",
      "longcat-2.5-free",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "minimax-m3",
      "minimax-m3.1-flash",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
      "step-5-preview",
    ]
    for (const id of ids) {
      const m = resolveModel(id)
      expect(m.providerId).toBe("opencode-go")
    }
  })

  it("applies models.dev caps and pricing (2026-11-01)", () => {
    setup()
    // Caps refreshed from models.dev where they previously drifted.
    expect(resolveModel("glm-5.3-flash").capabilities.contextWindow).toBe(1_000_000)
    expect(resolveModel("glm-5.3-flash").capabilities.maxOutputTokens).toBe(131_072)
    expect(resolveModel("kimi-k2.7-code").capabilities.maxOutputTokens).toBe(262_144)
    expect(resolveModel("minimax-m3").capabilities.maxOutputTokens).toBe(131_072)
    expect(resolveModel("grok-4.7").capabilities.maxOutputTokens).toBe(500_000)
    // DeepSeek Off-Peak tiers refreshed 2026-09-10 (docs/go + models.dev agree).
    expect(resolveModel("deepseek-v4.1-flash").pricing?.inputUSD).toBe(0.15)
    expect(resolveModel("deepseek-v4.1-flash").pricing?.outputUSD).toBe(0.6)
    expect(resolveModel("deepseek-v4.1-flash").pricing?.cacheReadUSD).toBe(0.003)
    expect(resolveModel("deepseek-v4-pro").pricing?.inputUSD).toBe(0.66)
    expect(resolveModel("deepseek-v4-pro").pricing?.outputUSD).toBe(1.98)
    expect(resolveModel("deepseek-v4-pro").pricing?.cacheReadUSD).toBe(0.022)

    // New 2026-09-10 models.
    const v41 = resolveModel("deepseek-v4.1-flash")
    expect(v41.surfaceId).toBe("openai-chat-completions")
    expect(v41.capabilities.contextWindow).toBe(1_000_000)
    expect(v41.capabilities.maxOutputTokens).toBe(384_000)
    expect(v41.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: false,
      video: false,
    })
    expect([...v41.capabilities.effort.levels]).toEqual(["low", "high", "max"])
    expect(v41.pricing?.inputUSD).toBe(0.15)
    expect(v41.pricing?.outputUSD).toBe(0.6)
    expect(v41.pricing?.cacheReadUSD).toBe(0.003)

    // New 2026-08-20 models.
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

    const glm53 = resolveModel("glm-5.3")
    expect(glm53.surfaceId).toBe("openai-chat-completions")
    expect(glm53.capabilities.contextWindow).toBe(1_000_000)
    expect(glm53.capabilities.maxOutputTokens).toBe(131_072)
    expect(glm53.capabilities.modalities).toEqual({
      image: false,
      audio: false,
      pdf: false,
      video: false,
    })
    expect([...glm53.capabilities.effort.levels]).toEqual(["low", "high", "max"])
    expect(glm53.pricing?.inputUSD).toBe(1.4)
    expect(glm53.pricing?.outputUSD).toBe(4.4)
    expect(glm53.pricing?.cacheReadUSD).toBe(0.26)

    const muse = resolveModel("muse-spark-1.2-contributor")
    expect(muse.surfaceId).toBe("openai-responses")
    expect(muse.capabilities.contextWindow).toBe(1_048_576)
    expect(muse.capabilities.maxOutputTokens).toBe(131_072)
    // The vendored Responses encoder has no audio or video part: the flags
    // follow the encoder (see input-formats.ts).
    expect(muse.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: true,
      video: false,
    })
    expect([...muse.capabilities.effort.levels]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    expect(muse.capabilities.tools.strictSchema).toBe(true)
    expect(muse.pricing?.inputUSD).toBe(0.1)
    expect(muse.pricing?.outputUSD).toBe(0.2)
    expect(muse.pricing?.cacheReadUSD).toBe(0.002)
    expect(muse.pricing?.cacheWriteUSD).toBe(0)

    const qwen38 = resolveModel("qwen3.8-max")
    expect(qwen38.surfaceId).toBe("anthropic-messages")
    expect(qwen38.capabilities.contextWindow).toBe(1_000_000)
    expect(qwen38.capabilities.maxOutputTokens).toBe(131_072)
    // Messages has no video part: the flags follow the encoder.
    expect(qwen38.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: false,
      video: false,
    })
    expect(qwen38.pricing?.inputUSD).toBe(2.0)
    expect(qwen38.pricing?.outputUSD).toBe(6.0)
    expect(qwen38.pricing?.cacheReadUSD).toBe(0.25)
    expect(qwen38.pricing?.cacheWriteUSD).toBe(2.5)

    // deepseek effort ladders synced to models.dev.
    expect([...resolveModel("deepseek-v4.1-flash").capabilities.effort.levels]).toEqual([
      "low",
      "high",
      "max",
    ])
    expect([...resolveModel("deepseek-v4-pro").capabilities.effort.levels]).toEqual(["high", "max"])

    // Hy3: models.dev effort none|low|high (none = thinking off).
    expect([...resolveModel("hy3").capabilities.effort.levels]).toEqual(["none", "low", "high"])

    // models.dev reasoning toggle → effort includes none (Messages thinking-off).
    for (const id of ["minimax-m3", "qwen3.8-max", "qwen3.7-plus"]) {
      expect([...resolveModel(id).capabilities.effort.levels]).toEqual([
        "none",
        "low",
        "medium",
        "high",
      ])
    }
    // Qwen3.8 Flash: toggle + low|medium|xhigh (models.dev).
    expect([...resolveModel("qwen3.8-flash").capabilities.effort.levels]).toEqual([
      "none",
      "low",
      "medium",
      "xhigh",
    ])
    // MiniMax M3.1 Flash (chat surface): full effort ladder.
    expect([...resolveModel("minimax-m3.1-flash").capabilities.effort.levels]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])

    // 2026-11-01 live catalog additions: surface + pricing smoke.
    expect(resolveModel("beam-free").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("beam-free").pricing?.inputUSD).toBe(0)
    expect([...resolveModel("beam-free").capabilities.effort.levels]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(resolveModel("gemini-4-argon").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("gemini-4-argon").capabilities.maxOutputTokens).toBe(65_536)
    expect(resolveModel("gemini-4-argon").pricing?.inputUSD).toBe(2)
    expect(resolveModel("gemini-4-argon").pricing?.outputUSD).toBe(10)
    expect(resolveModel("gemini-4-argon").capabilities.acceptsTemperature).toBe(false)
    expect(resolveModel("iceman-contributor-free").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("iceman-contributor-free").pricing?.inputUSD).toBe(0)
    expect(resolveModel("kimi-k3.1-pro").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("kimi-k3.1-pro").pricing?.inputUSD).toBe(2)
    expect(resolveModel("kimi-k3.1-pro").pricing?.cacheWriteUSD).toBe(2)
    expect([...resolveModel("kimi-k3.1-pro").capabilities.effort.levels]).toEqual([
      "low",
      "high",
      "max",
    ])
    expect(resolveModel("minimax-m3.1-flash").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("minimax-m3.1-flash").capabilities.maxOutputTokens).toBe(512_000)
    expect(resolveModel("minimax-m3.1-flash").pricing?.inputUSD).toBe(0.15)
    expect(resolveModel("step-5-preview").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("step-5-preview").pricing?.inputUSD).toBe(1)
    expect(resolveModel("step-5-preview").capabilities.maxOutputTokens).toBe(65_536)
    expect(resolveModel("grok-4.7").surfaceId).toBe("openai-responses")
    expect(resolveModel("grok-4.7").capabilities.maxOutputTokens).toBe(500_000)
    expect(resolveModel("grok-4.7").pricing?.cacheReadUSD).toBe(0.5)
    expect([...resolveModel("grok-4.7").capabilities.effort.levels]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    expect(resolveModel("gpt-6-luna").surfaceId).toBe("openai-responses")
    expect(resolveModel("gpt-6-luna").pricing?.inputUSD).toBe(0.1)
    expect(resolveModel("gpt-6-luna").pricing?.outputUSD).toBe(0.5)
    expect(resolveModel("gpt-6-luna").capabilities.acceptsTemperature).toBe(false)
    expect([...resolveModel("gpt-6-luna").capabilities.effort.levels]).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(resolveModel("claude-haiku-5-5").surfaceId).toBe("anthropic-messages")
    expect(resolveModel("claude-haiku-5-5").capabilities.contextWindow).toBe(1_000_000)
    expect(resolveModel("claude-haiku-5-5").capabilities.maxOutputTokens).toBe(128_000)
    expect(resolveModel("claude-haiku-5-5").capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: true,
      video: false,
    })
    expect([...resolveModel("claude-haiku-5-5").capabilities.effort.levels]).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(resolveModel("claude-haiku-5-5").pricing?.inputUSD).toBe(0.1)
    expect(resolveModel("mimo-v2.6-flash").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("mimo-v2.6-flash").capabilities.contextWindow).toBe(1_048_576)
    expect(resolveModel("mimo-v2.6-pro").pricing?.inputUSD).toBe(0.435)
    expect(resolveModel("longcat-2.0").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("muse-spark-1.3-contributor").surfaceId).toBe("openai-responses")
    expect(resolveModel("muse-spark-1.3-contributor").pricing?.inputUSD).toBe(0.1)
    expect(resolveModel("glm-5.3-flash").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("glm-5.3-flash").pricing?.inputUSD).toBe(0.15)
    expect(resolveModel("qwen3.8-flash").surfaceId).toBe("anthropic-messages")
    expect(resolveModel("hy4-preview").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("glm-5.2").surfaceId).toBe("openai-chat-completions")
    expect(resolveModel("mimo-v2.6-pro").surfaceId).toBe("openai-chat-completions")
  })

  it("registers ad-hoc slugs on demand", () => {
    setup()
    opencodeProviderPlugin.registerAdHocModel?.("deepseek-v4-ultra")
    const m = resolveModel("deepseek-v4-ultra")
    expect(m.providerId).toBe("opencode-go")
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
    const adapter = resolveProvider("opencode-go")
    const req: CanonicalRequest = { modelId: "deepseek-v4-pro", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("deepseek-v4-pro")).ok).toBe(true)
  })

  it("validates a plain Messages request via the REUSED Anthropic validator", () => {
    setup()
    const adapter = resolveProvider("opencode-go")
    const req: CanonicalRequest = { modelId: "qwen3.8-max", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("qwen3.8-max")).ok).toBe(true)
  })

  it("validates a plain Responses request and rejects temperature on Luna", () => {
    setup()
    const adapter = resolveProvider("opencode-go")
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
    const adapter = resolveProvider("opencode-go")
    const model = resolveModel("deepseek-v4-pro")
    const req: CanonicalRequest = { modelId: "deepseek-v4-pro", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "" },
      sessionId: "test",
    }
    await expect(async () => {
      for await (const _ of adapter.run(req, model, ctx)) {
        // should throw before yielding
      }
    }).toThrow("missing credential")
  })

  it("buildOpenAIHeaders sets auth + user-agent; x-opencode-session comes from opencodeHeaders, not here", () => {
    // S42 note: the vendored copy of this module took a `sessionId` option on
    // buildOpenAIHeaders and stamped `x-opencode-session` itself. The real
    // adapter path never called it that way -- it always sets that header
    // through `opencodeHeaders()` (see opencode-identity.ts, covered by
    // opencode-identity.test.ts and the "sends opencode identity headers..."
    // case below) -- so de-vendoring to the host's `OpenAIHeadersOpts`
    // (no `sessionId`) drops no real behavior. This case keeps coverage of
    // the auth + user-agent building buildOpenAIHeaders still does.
    const withAuth = buildOpenAIHeaders({
      auth: { kind: "api-key", key: "sk-test" },
      userAgent: "minimal-agent-opencode/0.1",
    })
    expect(withAuth["user-agent"]).toBe("minimal-agent-opencode/0.1")
    expect(withAuth.authorization).toBe("Bearer sk-test")

    const withoutUserAgent = buildOpenAIHeaders({ auth: { kind: "api-key", key: "sk-test" } })
    expect(withoutUserAgent["user-agent"]).toBeUndefined()
  })

  it("pins accept-encoding: gzip on the streaming request path and no other encoding", async () => {
    setup()
    const adapter = resolveProvider("opencode-go")
    const cases: Array<{ modelId: string; fixture: string }> = [
      { modelId: "deepseek-v4-pro", fixture: openaiChatPong() },
      { modelId: "qwen3.8-max", fixture: anthropicPong() },
      { modelId: "gpt-5.6-luna", fixture: openaiResponsesPong() },
    ]

    for (const { modelId, fixture } of cases) {
      const captured: NetworkRequestInput[] = []
      const networkClient: NetworkClient = {
        async request(input) {
          captured.push(input)
          return {
            status: 200,
            ok: true,
            headers: new Headers(),
            body: sseStream(fixture),
            transport: { id: "mock" },
            async text() {
              return ""
            },
            async json<T>(): Promise<T> {
              return {} as T
            },
          }
        },
      }
      const req: CanonicalRequest = { modelId, messages: [userText("hi")] }
      const ctx: RunContext = {
        auth: { kind: "api-key", key: "sk-test" },
        sessionId: "conversation-42",
        networkClient,
      }
      for await (const _ of adapter.run(req, resolveModel(modelId), ctx)) {
        // drain stream
      }

      expect(captured).toHaveLength(1)
      const headers = captured[0]!.headers!
      // gzip negotiated explicitly, so Bun never advertises br/zstd (which it
      // buffers whole, stalling token delivery) and node:http2 is not left
      // sending nothing at all.
      expect(headers["accept-encoding"]).toBe("gzip")
      expect(headers["accept-encoding"]).not.toContain("br")
      expect(headers["accept-encoding"]).not.toContain("zstd")
      expect(headers["accept-encoding"]).not.toBe("identity")
    }
  })

  it("passes the response content-encoding to parseSse so a gzip SSE body decodes", async () => {
    setup()
    const adapter = resolveProvider("opencode-go")
    // node:http2 hands back raw gzip with no decompression. The old parser fed
    // that to TextDecoder, yielding zero events and no error (a silent hang).
    const gz = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(openaiChatPong())))
    const networkClient: NetworkClient = {
      async request() {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ "content-encoding": "gzip" }),
          body: sseStream(gz),
          transport: { id: "mock" },
          async text() {
            return ""
          },
          async json<T>(): Promise<T> {
            return {} as T
          },
        }
      },
    }
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-pro",
      messages: [userText("hi")],
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "sk-test" },
      sessionId: "conversation-42",
      networkClient,
    }
    let text = ""
    for await (const ev of adapter.run(req, resolveModel("deepseek-v4-pro"), ctx))
      if (isEvent(ev, "text_delta")) text += ev.text
    // Proves the gzip frame was inflated: before the guard this yielded "".
    expect(text).toBe("pong")
  })

  it("throws an actionable error instead of hanging on a brotli SSE body", async () => {
    setup()
    const adapter = resolveProvider("opencode-go")
    const networkClient: NetworkClient = {
      async request() {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ "content-encoding": "br" }),
          body: sseStream(openaiChatPong()),
          transport: { id: "mock" },
          async text() {
            return ""
          },
          async json<T>(): Promise<T> {
            return {} as T
          },
        }
      },
    }
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-pro",
      messages: [userText("hi")],
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "sk-test" },
      sessionId: "conversation-42",
      networkClient,
    }
    await expect(async () => {
      for await (const _ of adapter.run(req, resolveModel("deepseek-v4-pro"), ctx)) {
        // should throw before yielding
      }
    }).toThrow(/"br"/)
  })

  it("sends opencode identity headers, inference URLs, stream, and read mapping on all surfaces", async () => {
    setup()
    const adapter = resolveProvider("opencode-go")
    const cases: Array<{ modelId: string; fixture: string }> = [
      { modelId: "deepseek-v4-pro", fixture: openaiChatPong() },
      { modelId: "qwen3.8-max", fixture: anthropicPong() },
      { modelId: "gpt-5.6-luna", fixture: openaiResponsesPong() },
    ]

    for (const { modelId, fixture } of cases) {
      const captured: NetworkRequestInput[] = []
      const networkClient: NetworkClient = {
        async request(input) {
          captured.push(input)
          return {
            status: 200,
            ok: true,
            headers: new Headers(),
            body: sseStream(fixture),
            transport: { id: "mock" },
            async text() {
              return ""
            },
            async json<T>(): Promise<T> {
              return {} as T
            },
          }
        },
      }
      const model = resolveModel(modelId)
      const req: CanonicalRequest = {
        modelId,
        messages: [userText("hi")],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object" } }],
      }
      const ctx: RunContext = {
        auth: { kind: "api-key", key: "sk-test" },
        sessionId: "conversation-42",
        networkClient,
      }
      for await (const _ of adapter.run(req, model, ctx)) {
        // drain stream
      }
      expect(captured).toHaveLength(1)
      const headers = captured[0]!.headers!
      expect(captured[0]!.url).toStartWith("https://opencode.ai/inference/go/")
      expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"])
      expect(headers["x-opencode-client"]).toBe("minimal-agent")
      expect(headers["user-agent"]).toMatch(/^opencode\/latest\/\d+\.\d+\.\d+\/minimal-agent$/)
      const body = JSON.parse(String(captured[0]!.body)) as {
        stream?: boolean
        tools?: Array<{ name?: string; function?: { name?: string } }>
      }
      expect(body.stream).toBe(true)
      const names = (body.tools ?? []).map((t) => t.function?.name ?? t.name)
      expect(names).toContain("read")
      expect(names).not.toContain("Read")
    }
  })

  it("emits tool_result blocks as role:tool messages (not silently dropped)", () => {
    setup()
    const model = resolveModel("deepseek-v4-pro")
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-pro",
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
                  text: '{"id":"deepseek-v4-pro","displayName":"DeepSeek V4 Flash"}',
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
    expect(toolMessages[0]!.content).toContain("deepseek-v4-pro")
    // Verify the message ordering: user → assistant (with tool_calls) → tool → user
    const roles = body.messages.map((m) => m.role)
    const toolIdx = roles.indexOf("tool")
    expect(toolIdx).toBeGreaterThan(roles.indexOf("assistant"))
  })

  it("maps Chat effort none to reasoning_effort none (Hy3)", () => {
    setup()
    const model = resolveModel("hy3")
    const req: CanonicalRequest = {
      modelId: "hy3",
      messages: [userText("hi")],
      effort: "none",
    }
    expect(resolveProvider("opencode-go").validate(req, model).ok).toBe(true)
    const body = buildOpenAIChatBody(req, model)
    // Host `OpenAIChatRequestBody.reasoning_effort` is typed as
    // `"low" | "medium" | "high" | "max"` -- the host adapter never sends
    // "none" on the wire. OpenCode Go's Hy3 toggle model does (verified at
    // runtime: the function assigns `req.effort` through unchanged), so the
    // real value here is "none" even though the host's declared type says
    // otherwise. Widen the static type at the read site rather than fork
    // `openai-chat.ts` for one field.
    expect(body.reasoning_effort as string | undefined).toBe("none")
  })

  it("maps Messages effort none to thinking off (omit thinking + no output_config.effort)", () => {
    setup()
    const model = resolveModel("qwen3.8-max")
    const req: CanonicalRequest = {
      modelId: "qwen3.8-max",
      messages: [userText("hi")],
      effort: "none",
    }
    expect(resolveProvider("opencode-go").validate(req, model).ok).toBe(true)
    const body = buildAnthropicRequestBody(req, model)
    expect(body.thinking).toBeUndefined()
    expect(body.output_config?.effort).toBeUndefined()
    expect(body.context_management).toBeUndefined()
  })

  it("keeps Messages adaptive thinking when effort is unset", () => {
    setup()
    const model = resolveModel("qwen3.8-max")
    const req: CanonicalRequest = {
      modelId: "qwen3.8-max",
      messages: [userText("hi")],
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config?.effort).toBe("medium")
  })

  const KEY = process.env.MINIMAL_AGENT_OPENCODE_LIVE_KEY
  it.skipIf(!KEY)("live: deepseek-v4-pro via OpenCode Go (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("deepseek-v4-pro")
    const provider = resolveProvider("opencode-go")
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-pro",
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
  })
})

describe("Responses text.format (SPEC-ONESHOT T4c)", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } }
  const req = (outputFormat: CanonicalRequest["outputFormat"]): CanonicalRequest => ({
    modelId: "gpt-5.6-luna",
    messages: [userText("hi")],
    outputFormat,
  })

  it("sends a flat text.format and no response_format", () => {
    const model = resolveModel("gpt-5.6-luna")
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "title", schema, strict: true }),
      model,
    )
    expect("response_format" in body).toBe(false)
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "title", schema, strict: true },
    })
  })

  it("gates strict on capabilities.structuredOutputs", () => {
    const base = resolveModel("gpt-5.6-luna")
    const model = { ...base, capabilities: { ...base.capabilities, structuredOutputs: false } }
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "title", schema, strict: true }),
      model,
    )
    expect(body.text?.format).toEqual({ type: "json_schema", name: "title", schema })
    const loose = buildOpenAIResponsesBody(req({ type: "json_schema", name: "t", schema }), base)
    expect("strict" in (loose.text?.format ?? {})).toBe(false)
  })

  it("sanitizes the schema name", () => {
    const model = resolveModel("gpt-5.6-luna")
    const bad = buildOpenAIResponsesBody(req({ type: "json_schema", name: "a b.c", schema }), model)
    expect(bad.text?.format).toMatchObject({ name: "a_b_c" })
    const long = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "x".repeat(80), schema }),
      model,
    )
    expect(long.text?.format).toMatchObject({ name: "x".repeat(64) })
    const none = buildOpenAIResponsesBody(req({ type: "json_schema", schema }), model)
    expect(none.text?.format).toMatchObject({ name: "output" })
  })

  it("maps json_object and text", () => {
    const model = resolveModel("gpt-5.6-luna")
    expect(buildOpenAIResponsesBody(req({ type: "json_object" }), model).text).toEqual({
      format: { type: "json_object" },
    })
    expect(buildOpenAIResponsesBody(req({ type: "text" }), model).text).toEqual({
      format: { type: "text" },
    })
  })
})

describe("Anthropic output_config.format (SPEC-ONESHOT T4c)", () => {
  it("sends exactly {type, schema} (no name, no strict)", () => {
    const model = resolveModel("qwen3.8-max")
    const schema = { type: "object", properties: { a: { type: "string" } } }
    const body = buildAnthropicRequestBody(
      {
        modelId: "qwen3.8-max",
        messages: [userText("hi")],
        outputFormat: { type: "json_schema", name: "title", schema, strict: true },
      },
      model,
    )
    expect(body.output_config?.format).toEqual({ type: "json_schema", schema })
  })
})
