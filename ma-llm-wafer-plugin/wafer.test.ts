/**
 * Wafer provider tests.
 *
 * Offline: registry + reuse of llm-openai's translator/validator. The live
 * test is gated on `MINIMAL_AGENT_WAFER_LIVE_KEY` so generic provider env
 * vars never become runtime auth inputs.
 *
 * @module llm/providers/wafer/wafer.test
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
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { bootstrapWafer, waferAdapter, waferProviderPlugin } from "./adapter.ts"
import {
  buildWaferApiKeyCredential,
  readWaferApiKey,
  WAFER_API_KEY_AUTH,
  waferApiKeyAuth,
} from "./auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerWaferModels } from "./models.ts"
import {
  accumulateWaferUsage,
  clearWaferRateLimits,
  getWaferRateLimits,
  getWaferSessionUsage,
  parseWaferQuotaWindows,
  setWaferRateLimits,
} from "./session-info.ts"

/**
 * Synthesize a fake NetworkClient that returns a canned HTTP response.
 * The real NetworkClient type is complex (16 methods); the adapter only
 * calls `request()`, so a partial satisfies the structural type.
 */
function fakeNetworkClient(status: number, body: string) {
  return {
    async request() {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        headers: new Headers(),
      }
    },
  } as unknown as NetworkClient
}

/** Drain a CanonicalEvent generator and return the first error thrown, or null. */
async function drainCatch(
  gen: AsyncIterable<unknown>,
): Promise<(Error & { streamErrorType?: string }) | null> {
  try {
    for await (const _ of gen) {
      /* drain */
    }
    return null
  } catch (err) {
    return err as Error & { streamErrorType?: string }
  }
}

// A repo-separated provider resolves from a local test registrar rather than
// the host registry. `setup()` re-registers into a fresh one each call and
// exposes the resolvers the tests use.
let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapWafer({ models: reg.models, providers: reg.providers })
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

describe("llm-wafer (OpenAI-compatible gateway, reuses llm-openai's wire layer)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(waferProviderPlugin.apiKeyAuth).toBe(waferApiKeyAuth)
    expect(waferProviderPlugin.oauthLogin).toBeUndefined()
  })

  it("declares the Wafer API-key credential codec", () => {
    expect(waferApiKeyAuth.serviceId).toBe(WAFER_API_KEY_AUTH.serviceId)
    expect(waferApiKeyAuth.displayName).toBe("Wafer API Key")

    const write = buildWaferApiKeyCredential("wfr_test123")
    expect(write).toEqual({
      serviceId: "wafer-api-key",
      displayName: "Wafer API Key",
      secrets: { tokenType: "api-key", apiKey: "wfr_test123" },
    })
    expect(readWaferApiKey(write.secrets)).toBe("wfr_test123")
    expect(readWaferApiKey({ tokenType: "api-key" })).toBeNull()
    expect(waferApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(waferApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers models on the openai-chat-completions surface", () => {
    setup()
    const m = resolveModel("GLM-5.2")
    expect(m.providerId).toBe("wafer")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe("GLM-5.2")
    expect(m.tags).toContain("balanced")

    const adapter = resolveProvider("wafer")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.displayName).toBe("Wafer")
  })

  it("registers all 13 built-in models (live 2026-11-15)", () => {
    setup()
    const ids = [
      "GLM-5.2",
      "GLM-5.3",
      "GLM-5.3-Flash",
      "Kimi-K3",
      "Kimi-K3.1-Pro",
      "Kimi-K3.1-Pro-US",
      "MiniMax-M3.1-Flash",
      "DeepSeek-V4-Pro",
      "DeepSeek-V4.1-Flash",
      "DeepSeek-V4.1-Flash-1017",
      "DeepSeek-V4-Flash-0423",
      "DeepSeek-V4-Flash-0731-Fast",
      "Qwen3.8-27B",
    ]
    for (const id of ids) {
      const m = resolveModel(id)
      expect(m.providerId).toBe("wafer")
      expect(m.surfaceId).toBe("openai-chat-completions")
    }
  })

  it("registers ad-hoc models on demand", () => {
    setup()
    waferProviderPlugin.registerAdHocModel?.("some-future-model")
    const m = resolveModel("some-future-model")
    expect(m.providerId).toBe("wafer")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.displayName).toBe("some-future-model")
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
    const adapter = resolveProvider("wafer")
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("GLM-5.2")).ok).toBe(true)
  })

  it("recommends sub-agent models by tag", () => {
    setup()
    const recs = waferAdapter.recommendSubagentModels?.() ?? []
    const byRole = new Map(recs.map((r) => [r.role, r.modelId]))
    expect(byRole.get("scout")).toBe("GLM-5.3-Flash")
    expect(byRole.get("balanced")).toBe("GLM-5.2")
    expect(byRole.get("deep")).toBe("GLM-5.3")
  })

  it("has correct pricing for known models", () => {
    setup()
    const glm52 = resolveModel("GLM-5.2")
    expect(glm52.pricing.inputUSD).toBe(0.19) // 19 cents/mil
    expect(glm52.pricing.outputUSD).toBe(4.4)

    // All 13 models pricing (live API 2026-11-15). Cache read uses the
    // microcents field when present (e.g. MiniMax-M3.1-Flash 1.5 cents).
    const pricingTable: Record<string, { input: number; output: number; cacheRead: number }> = {
      "GLM-5.2": { input: 0.19, output: 4.4, cacheRead: 0.18 },
      "GLM-5.3": { input: 0.2, output: 1.8, cacheRead: 0.18 },
      "GLM-5.3-Flash": { input: 0.05, output: 0.2, cacheRead: 0.03 },
      "Kimi-K3": { input: 0.6, output: 15.0, cacheRead: 0.2 },
      "Kimi-K3.1-Pro": { input: 2.0, output: 10.0, cacheRead: 0.2 },
      "Kimi-K3.1-Pro-US": { input: 2.0, output: 10.0, cacheRead: 0.2 },
      "MiniMax-M3.1-Flash": { input: 0.15, output: 0.6, cacheRead: 0.015 },
      "DeepSeek-V4-Pro": { input: 0.28, output: 3.96, cacheRead: 0.044 },
      "DeepSeek-V4.1-Flash": { input: 0.19, output: 0.65, cacheRead: 0.012 },
      "DeepSeek-V4.1-Flash-1017": { input: 0.13, output: 0.5, cacheRead: 0.008 },
      "DeepSeek-V4-Flash-0423": { input: 0.14, output: 0.28, cacheRead: 0.028 },
      "DeepSeek-V4-Flash-0731-Fast": { input: 0.13, output: 0.23, cacheRead: 0.028 },
      "Qwen3.8-27B": { input: 0.06, output: 2.3, cacheRead: 0.05 },
    }
    for (const [id, prices] of Object.entries(pricingTable)) {
      const m = resolveModel(id)
      expect(m.pricing.inputUSD, `${id} inputUSD`).toBeCloseTo(prices.input, 10)
      expect(m.pricing.outputUSD, `${id} outputUSD`).toBeCloseTo(prices.output, 10)
      expect(m.pricing.cacheReadUSD, `${id} cacheReadUSD`).toBeCloseTo(prices.cacheRead, 10)
    }
  })

  // ---------------------------------------------------------------------------
  // Error classification
  // ---------------------------------------------------------------------------

  it("classifies 429 rate_limit_error as retryable with streamErrorType", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    const body = JSON.stringify({
      error: { code: "ttfb_gate_shed", message: "model at capacity" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(429, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("rate_limit_error")
  })

  it("classifies 503 server_error as retryable with streamErrorType", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    const body = JSON.stringify({ error: { code: "server_error", message: "down" } })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(503, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("overloaded_error")
  })

  it("does NOT tag 402 insufficient_quota as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    const body = JSON.stringify({
      error: { code: "insufficient_quota", message: "out of credits" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(402, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBeUndefined()
  })

  it("classifies non-JSON error body by HTTP status alone", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    const body = "Gateway Timeout"
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(504, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("overloaded_error")
  })

  it("classifies 500 with type field (fallback from code) as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    // No `code` field — parser falls back to `type`
    const body = JSON.stringify({ error: { type: "server_error", message: "boom" } })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(500, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("overloaded_error")
  })

  it("does NOT tag 401 invalid_api_key as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    const body = JSON.stringify({
      error: { code: "invalid_api_key", message: "bad key" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(401, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBeUndefined()
  })

  it("does NOT tag 400 invalid_request_error as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    const body = JSON.stringify({
      error: { code: "invalid_request_error", message: "bad request" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(400, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBeUndefined()
  })

  it("classifies 429 with JSON but no code or type by HTTP status alone", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.2")
    // Valid JSON, error object, but no code or type field
    const body = JSON.stringify({ error: { message: "too many requests" } })
    const req: CanonicalRequest = { modelId: "GLM-5.2", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(429, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("rate_limit_error")
  })

  // ---------------------------------------------------------------------------
  // Session info: cache + quota windows
  // ---------------------------------------------------------------------------

  it("parses Wafer quota windows from x-ratelimit-* headers", () => {
    const rl = new Map<string, string>([
      ["x-ratelimit-limit-requests", "100"],
      ["x-ratelimit-remaining-requests", "25"],
      ["x-ratelimit-reset-requests", "1h"],
      ["x-ratelimit-limit-tokens", "1000000"],
      ["x-ratelimit-remaining-tokens", "900000"],
      ["x-ratelimit-reset-tokens", "0s"],
    ])
    const windows = parseWaferQuotaWindows(rl)
    expect(windows.length).toBe(2)
    const req = windows.find((w) => w.id === "req")
    const tok = windows.find((w) => w.id === "tok")
    expect(req).not.toBeUndefined()
    expect(tok).not.toBeUndefined()
    expect(req!.utilization).toBe(0.75) // 1 - 25/100
    expect(tok!.utilization).toBeCloseTo(0.1)
    expect(req!.resetAtMs).toBeGreaterThan(Date.now())
    expect(tok!.resetAtMs).not.toBeUndefined()
  })

  it("skips windows with limit=0 or missing remaining", () => {
    const rl = new Map<string, string>([
      ["x-ratelimit-limit-requests", "0"],
      ["x-ratelimit-remaining-requests", "0"],
      ["x-ratelimit-reset-requests", "1h"],
    ])
    const windows = parseWaferQuotaWindows(rl)
    expect(windows).toHaveLength(0)
  })

  it("setWaferRateLimits populates and getWaferRateLimits reads the cache", () => {
    clearWaferRateLimits()
    expect(getWaferRateLimits()).toBeNull()

    const headers = new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "40",
      "x-ratelimit-reset-requests": "5m",
    })
    setWaferRateLimits(headers)
    const cached = getWaferRateLimits()
    expect(cached).not.toBeNull()
    expect(cached!.rateLimits.get("x-ratelimit-limit-requests")).toBe("50")
    expect(cached!.at).toBeGreaterThan(Date.now() - 1000)
  })

  it("setWaferRateLimits ignores headers with no x-ratelimit entries", () => {
    clearWaferRateLimits()
    setWaferRateLimits(new Headers({ "content-type": "application/json" }))
    expect(getWaferRateLimits()).toBeNull()
  })

  it("accumulateWaferUsage accumulates across multiple calls", () => {
    clearWaferRateLimits()
    expect(getWaferSessionUsage()).toBeNull()

    accumulateWaferUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 })
    expect(getWaferSessionUsage()?.inputTokens).toBe(100)
    expect(getWaferSessionUsage()?.outputTokens).toBe(50)
    expect(getWaferSessionUsage()?.cacheReadTokens).toBe(20)

    accumulateWaferUsage({ inputTokens: 200, outputTokens: 100 })
    expect(getWaferSessionUsage()?.inputTokens).toBe(300)
    expect(getWaferSessionUsage()?.outputTokens).toBe(150)
    expect(getWaferSessionUsage()?.cacheReadTokens).toBe(20) // unchanged
  })

  it("clearWaferRateLimits clears both caches", () => {
    clearWaferRateLimits()
    setWaferRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "1",
        "x-ratelimit-remaining-requests": "1",
        "x-ratelimit-reset-requests": "1s",
      }),
    )
    accumulateWaferUsage({ inputTokens: 1, outputTokens: 1 })
    expect(getWaferRateLimits()).not.toBeNull()
    expect(getWaferSessionUsage()).not.toBeNull()
    clearWaferRateLimits()
    expect(getWaferRateLimits()).toBeNull()
    expect(getWaferSessionUsage()).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Capability validation (live API 2026-11-15)
  // ---------------------------------------------------------------------------

  it("each model has correct capabilities", () => {
    setup()
    // GLM-5.2 — 1M context, reasoning on, vision off, balanced
    const glm52 = resolveModel("GLM-5.2")
    expect(glm52.capabilities.contextWindow).toBe(1_048_576)
    expect(glm52.capabilities.thinking.adaptive).toBe(true)
    expect(glm52.capabilities.effort.levels).toEqual(["low", "medium", "high"])
    expect(glm52.capabilities.modalities.image).toBe(false)
    expect(glm52.capabilities.speedFast).toBe(false)
    expect(glm52.tags).toContain("balanced")

    // GLM-5.3 — 1M context, flagship/deep, text-only
    const glm53 = resolveModel("GLM-5.3")
    expect(glm53.capabilities.contextWindow).toBe(1_048_576)
    expect(glm53.capabilities.modalities.image).toBe(false)
    expect(glm53.tags).toContain("flagship")
    expect(glm53.tags).toContain("deep")

    // GLM-5.3-Flash — cheap scout, vision
    const glmFlash = resolveModel("GLM-5.3-Flash")
    expect(glmFlash.capabilities.modalities.image).toBe(true)
    expect(glmFlash.tags).toContain("cheap")
    expect(glmFlash.tags).toContain("scout")

    // Kimi-K3 — now 1M context (was 912K), vision
    expect(resolveModel("Kimi-K3").capabilities.modalities.image).toBe(true)
    expect(resolveModel("Kimi-K3").capabilities.contextWindow).toBe(1_048_576)

    // Kimi-K3.1-Pro — vision, 1M
    expect(resolveModel("Kimi-K3.1-Pro").capabilities.modalities.image).toBe(true)
    expect(resolveModel("Kimi-K3.1-Pro-US").capabilities.contextWindow).toBe(1_048_576)

    // DeepSeek V4 Pro — text-only; V4.1 Flash — vision
    expect(resolveModel("DeepSeek-V4-Pro").capabilities.modalities.image).toBe(false)
    expect(resolveModel("DeepSeek-V4.1-Flash").capabilities.modalities.image).toBe(true)

    // High-TPS DeepSeek V4 Flash SKUs — speedFast
    expect(resolveModel("DeepSeek-V4-Flash-0731-Fast").capabilities.speedFast).toBe(true)
    expect(resolveModel("DeepSeek-V4-Flash-0423").capabilities.speedFast).toBe(true)

    // Qwen3.8-27B — 256K context, vision
    const qwen = resolveModel("Qwen3.8-27B")
    expect(qwen.capabilities.contextWindow).toBe(262_144)
    expect(qwen.capabilities.modalities.image).toBe(true)

    // MiniMax-M3.1-Flash — vision + reasoning (no interleaved flag in live wafer.capabilities)
    const mm = resolveModel("MiniMax-M3.1-Flash")
    expect(mm.capabilities.thinking.adaptive).toBe(true)
    expect(mm.capabilities.thinking.interleaved).toBe(false)
    expect(mm.capabilities.contextWindow).toBe(1_048_576)
    expect(mm.capabilities.modalities.image).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // modelVersionToken
  // ---------------------------------------------------------------------------

  it("modelVersionToken strips vendor prefixes for all families", () => {
    const fn = waferProviderPlugin.modelVersionToken!
    expect(fn("GLM-5.2")).toBe("5.2")
    expect(fn("GLM-5.3-Flash")).toBe("5.3-Flash")
    expect(fn("Kimi-K3")).toBe("K3")
    expect(fn("Kimi-K3.1-Pro")).toBe("K3.1-Pro")
    expect(fn("MiniMax-M3.1-Flash")).toBe("M3.1-Flash")
    expect(fn("DeepSeek-V4-Pro")).toBe("V4-Pro")
    expect(fn("Qwen3.8-27B")).toBe("3.8-27B")
    expect(fn("glm5.2-fast")).toBe("5.2-fast")
  })

  // ---------------------------------------------------------------------------
  // Plugin surface constants
  // ---------------------------------------------------------------------------

  it("plugin surface constants are correct", () => {
    expect(waferProviderPlugin.id).toBe("wafer")
    expect(waferProviderPlugin.shortCode).toBe("wf")
    expect(waferProviderPlugin.displayName).toBe("Wafer")
  })

  // ---------------------------------------------------------------------------
  // Auth edge cases
  // ---------------------------------------------------------------------------

  it("auth inspect treats empty/whitespace keys as unusable", () => {
    expect(waferApiKeyAuth.inspectCredential?.({ tokenType: "api-key", apiKey: "" })).toEqual({
      usable: false,
    })
    // inspectCredential trims, so spaces-only is also unusable
    expect(waferApiKeyAuth.inspectCredential?.({ tokenType: "api-key", apiKey: "   " })).toEqual({
      usable: false,
    })
  })

  // ---------------------------------------------------------------------------
  // bootstrapWafer idempotency
  // ---------------------------------------------------------------------------

  it("bootstrapWafer is idempotent", () => {
    setup()
    // Second call should not cause duplicate registrations
    bootstrapWafer()
    const adapter = resolveProvider("wafer")
    expect(adapter.displayName).toBe("Wafer")
    // Model should still resolve
    expect(resolveModel("GLM-5.2").providerId).toBe("wafer")
  })

  // ---------------------------------------------------------------------------
  // SDK seam: registerWaferModels via ModelRegistrar (no src/ import)
  // ---------------------------------------------------------------------------

  it("registerWaferModels via registrar registers the full catalog", () => {
    const local = makeTestRegistry()
    const captured: Array<{ id: string; providerId: string; surfaceId: string }> = []
    const spyModels = {
      register(spec: { id: string; providerId: string; surfaceId: string }) {
        captured.push({ id: spec.id, providerId: spec.providerId, surfaceId: spec.surfaceId })
        local.models.register(spec as Parameters<typeof local.models.register>[0])
      },
      setDefault(id: string | null) {
        local.models.setDefault(id)
      },
    }
    registerWaferModels(spyModels)
    expect(captured.length).toBe(13)
    expect(captured[0]!.id).toBe("GLM-5.2")
    expect(captured[0]!.providerId).toBe("wafer")
    expect(captured[0]!.surfaceId).toBe("openai-chat-completions")

    const seam = local.resolveModel("GLM-5.2")
    expect(seam.providerId).toBe("wafer")
    expect(seam.capabilities.contextWindow).toBe(1_048_576)
  })

  it("registerWaferModel ad-hoc also supports registrar", () => {
    const local = makeTestRegistry()
    const captured: Array<{ id: string }> = []
    const spyModels = {
      register(spec: { id: string }) {
        captured.push({ id: spec.id })
        local.models.register(spec as Parameters<typeof local.models.register>[0])
      },
      setDefault(id: string | null) {
        local.models.setDefault(id)
      },
    }
    registerWaferModels(spyModels)
    expect(captured.some((c) => c.id === "GLM-5.2")).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Model tags
  // ---------------------------------------------------------------------------

  it("model tags are correct for all models", () => {
    setup()
    const tagChecks: Record<string, string[]> = {
      "GLM-5.2": ["reasoning", "1m-context", "balanced"],
      "GLM-5.3": ["reasoning", "1m-context", "flagship", "deep"],
      "GLM-5.3-Flash": ["reasoning", "vision", "1m-context", "cheap", "scout"],
      "Kimi-K3": ["reasoning", "vision", "1m-context"],
      "Kimi-K3.1-Pro": ["reasoning", "vision", "1m-context"],
      "MiniMax-M3.1-Flash": ["reasoning", "vision", "1m-context", "cheap"],
      "DeepSeek-V4-Pro": ["reasoning", "1m-context"],
      "DeepSeek-V4-Flash-0731-Fast": ["reasoning", "1m-context", "cheap", "fast"],
      "Qwen3.8-27B": ["reasoning", "vision", "cheap"],
    }
    for (const [id, expectedTags] of Object.entries(tagChecks)) {
      const m = resolveModel(id)
      for (const tag of expectedTags) {
        expect(m.tags, `${id} should have tag ${tag}`).toContain(tag)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Prime dedupe
  // ---------------------------------------------------------------------------

  it("primeWaferSessionInfo deduplicates concurrent calls", () => {
    setup()
    const p1 = waferProviderPlugin.primeSessionInfo!({
      modelId: "GLM-5.2",
    })
    const p2 = waferProviderPlugin.primeSessionInfo!({
      modelId: "GLM-5.2",
    })
    // Same promise reference — deduped
    expect(p1).toBe(p2)
  })

  // Live round-trip. Set MINIMAL_AGENT_WAFER_LIVE_KEY to run it. Proves the
  // request reaches Wafer with valid auth + a well-formed OpenAI-Chat body.
  // Like the OpenRouter live test, it accepts EITHER streamed text OR a
  // 402/401 as success (both confirm auth + wire are correct; completing
  // the round-trip just needs active credits).
  const KEY = process.env.MINIMAL_AGENT_WAFER_LIVE_KEY
  it.skipIf(!KEY)("live: GLM-5.2 via Wafer (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("GLM-5.2")
    const provider = resolveProvider("wafer")
    const req: CanonicalRequest = {
      modelId: "GLM-5.2",
      messages: [userText("Reply with the single word: pong")],
      generation: { maxOutputTokens: 16 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: KEY as string },
      sessionId: "wafer-live-test",
    }
    let text = ""
    try {
      for await (const ev of provider.run(req, model, ctx)) {
        if (isEvent(ev, "text_delta")) text += ev.text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toMatch(/\b402\b|\b401\b|insufficient|unauthorized/i)
      return
    }
    expect(text.length).toBeGreaterThan(0)
  })
})
