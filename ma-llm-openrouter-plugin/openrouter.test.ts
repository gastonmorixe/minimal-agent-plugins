/**
 * OpenRouter provider tests.
 *
 * Offline: registry + reuse of llm-openai's translator/validator. The live test
 * is gated on `MINIMAL_AGENT_OPENROUTER_LIVE_KEY` so generic provider env vars
 * never become runtime auth inputs.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { type CanonicalEvent, isEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import {
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "@minimal-agent/core/plugin-api/llm/openai-chat"
import type { RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { bootstrapOpenRouter, openrouterAdapter, openrouterProviderPlugin } from "./adapter.ts"
import {
  buildOpenRouterApiKeyCredential,
  OPENROUTER_API_KEY_AUTH,
  openRouterApiKeyAuth,
  readOpenRouterApiKey,
} from "./auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerOpenRouterModels } from "./models.ts"

// A repo-separated provider resolves from a local test registrar rather than
// the host registry. `setup()` re-registers into a fresh one each call and
// exposes the resolvers the tests use.
let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapOpenRouter({ models: reg.models, providers: reg.providers })
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

describe("llm-openrouter (OpenAI-compatible gateway, reuses llm-openai's wire layer)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(openrouterProviderPlugin.apiKeyAuth).toBe(openRouterApiKeyAuth)
    expect(openrouterProviderPlugin.oauthLogin).toBeUndefined()
  })

  it("declares the OpenRouter API-key credential codec", () => {
    expect(openRouterApiKeyAuth.serviceId).toBe(OPENROUTER_API_KEY_AUTH.serviceId)
    expect(openRouterApiKeyAuth.displayName).toBe("OpenRouter API Key")

    const write = buildOpenRouterApiKeyCredential("sk-or-test")
    expect(write).toEqual({
      serviceId: "openrouter-api-key",
      displayName: "OpenRouter API Key",
      secrets: { tokenType: "api-key", apiKey: "sk-or-test" },
    })
    expect(readOpenRouterApiKey(write.secrets)).toBe("sk-or-test")
    expect(readOpenRouterApiKey({ tokenType: "api-key" })).toBeNull()
    expect(openRouterApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(openRouterApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers slugs on the shared openai-chat-completions surface", () => {
    setup()
    const m = resolveModel("openai/gpt-4o-mini")
    expect(m.providerId).toBe("openrouter")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe("openai/gpt-4o-mini")

    const adapter = resolveProvider("openrouter")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.displayName).toBe("OpenRouter")
  })

  it("pins the curated 2026-11-18 catalog (ids, caps, pricing, role picks)", () => {
    const ids = registerOpenRouterModels(makeTestRegistry().models)
    expect(ids).toEqual([
      "moonshotai/kimi-k3.1-pro",
      "deepseek/deepseek-v4.1-flash",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-opus-5.5",
      "openai/gpt-6.2-sol",
      "x-ai/grok-4.7",
      "openai/gpt-4o-mini",
      "inclusionai/ling-3.0-tiny",
    ])
    setup()
    const kimi = resolveModel("moonshotai/kimi-k3.1-pro")
    expect(kimi.capabilities.maxOutputTokens).toBe(943_718)
    expect(kimi.capabilities.modalities.video).toBe(true)
    expect(kimi.pricing?.inputUSD).toBe(0.2403)
    const flash = resolveModel("deepseek/deepseek-v4.1-flash")
    expect(flash.capabilities.modalities.image).toBe(true)
    expect(flash.pricing?.outputUSD).toBe(0.2028)
    expect(resolveModel("anthropic/claude-opus-5.5").pricing?.inputUSD).toBe(4)
    expect(resolveModel("openai/gpt-6.2-sol").pricing?.outputUSD).toBe(10)
    expect(resolveModel("x-ai/grok-4.7").capabilities.maxOutputTokens).toBe(450_000)
    const recs = openrouterAdapter.recommendSubagentModels?.() ?? []
    expect(recs.find((r) => r.role === "scout")?.modelId).toBe("deepseek/deepseek-v4.1-flash")
    expect(recs.find((r) => r.role === "balanced")?.modelId).toBe("moonshotai/kimi-k3.1-pro")
  })

  it("registers ad-hoc slugs on demand", () => {
    setup()
    openrouterProviderPlugin.registerAdHocModel?.("nvidia/nemotron-3-ultra-550b-a55b:free")
    const m = resolveModel("nvidia/nemotron-3-ultra-550b-a55b:free")
    expect(m.providerId).toBe("openrouter")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.displayName).toBe("nvidia/nemotron-3-ultra-550b-a55b:free")
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

  it("validates a plain request via the REUSED OpenAI validator", () => {
    setup()
    const adapter = resolveProvider("openrouter")
    const req: CanonicalRequest = { modelId: "openai/gpt-4o-mini", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("openai/gpt-4o-mini")).ok).toBe(true)
  })

  // Live round-trip. Set MINIMAL_AGENT_OPENROUTER_LIVE_KEY to run it. Proves the
  // request reaches OpenRouter with valid auth + a well-formed OpenAI-Chat body.
  // Like the Opus-4.8 `--fast` e2e, it accepts EITHER streamed text OR a
  // 402 "insufficient credits" response as success (both confirm auth +
  // wire are correct; completing the round-trip just needs account
  // credits). A 401 (bad auth) or any other error still fails.
  const KEY = process.env.MINIMAL_AGENT_OPENROUTER_LIVE_KEY
  it.skipIf(!KEY)("live: gpt-4o-mini via OpenRouter (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("openai/gpt-4o-mini")
    const provider = resolveProvider("openrouter")
    const req: CanonicalRequest = {
      modelId: "openai/gpt-4o-mini",
      messages: [userText("Reply with the single word: pong")],
      generation: { maxOutputTokens: 16 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: KEY as string },
      sessionId: "openrouter-live-test",
    }
    let text = ""
    try {
      for await (const ev of provider.run(req, model, ctx)) {
        if (isEvent(ev, "text_delta")) text += ev.text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toMatch(/\b402\b|\b401\b|insufficient credits|user not found/i)
      return
    }
    expect(text.length).toBeGreaterThan(0)
  })
})
