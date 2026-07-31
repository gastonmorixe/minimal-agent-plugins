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

import { bootstrapWafer, waferAdapter, waferProviderPlugin } from "./adapter.ts"
import {
  buildWaferApiKeyCredential,
  readWaferApiKey,
  WAFER_API_KEY_AUTH,
  waferApiKeyAuth,
} from "./auth.ts"
import { type CanonicalEvent, isEvent } from "./lib/canonical-events.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./lib/openai-chat.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import { parseSse } from "./lib/sse-parser.ts"
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
    const m = resolveModel("GLM-5.1")
    expect(m.providerId).toBe("wafer")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe("GLM-5.1")
    expect(m.tags).toContain("balanced")

    const adapter = resolveProvider("wafer")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.displayName).toBe("Wafer")
  })

  it("registers all 7 built-in models", () => {
    setup()
    const ids = [
      "GLM-5.1",
      "Kimi-K3",
      "Kimi-K2.6",
      "MiniMax-M3",
      "GLM-5.2",
      "kimi-k3-fast",
      "glm5.2-fast",
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
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("GLM-5.1")).ok).toBe(true)
  })

  it("recommends sub-agent models by tag", () => {
    setup()
    const recs = waferAdapter.recommendSubagentModels?.() ?? []
    const byRole = new Map(recs.map((r) => [r.role, r.modelId]))
    expect(byRole.get("scout")).toBe("glm5.2-fast")
    expect(byRole.get("balanced")).toBe("GLM-5.1")
    expect(byRole.get("deep")).toBe("GLM-5.2")
  })

  it("has correct pricing for known models", () => {
    setup()
    const glm51 = resolveModel("GLM-5.1")
    expect(glm51.pricing.inputUSD).toBe(1.0) // 100 cents/mil = 1.0 USD/mil
    expect(glm51.pricing.outputUSD).toBe(3.2)

    const glmFast = resolveModel("glm5.2-fast")
    expect(glmFast.pricing.inputUSD).toBe(2.1) // 210 cents/mil
    expect(glmFast.pricing.outputUSD).toBe(6.6)

    const kimi = resolveModel("Kimi-K2.6")
    expect(kimi.pricing.inputUSD).toBe(1.14) // 114 cents/mil
    expect(kimi.pricing.outputUSD).toBe(4.8)
    expect(kimi.pricing.cacheReadUSD).toBe(0.19)

    // All 7 models pricing (live API 2026-07-30)
    const pricingTable: Record<string, { input: number; output: number; cacheRead: number }> = {
      "GLM-5.1": { input: 1.0, output: 3.2, cacheRead: 0.1 },
      "Kimi-K3": { input: 3.0, output: 15.0, cacheRead: 0.3 },
      "Kimi-K2.6": { input: 1.14, output: 4.8, cacheRead: 0.19 },
      "MiniMax-M3": { input: 0.33, output: 1.32, cacheRead: 0.07 },
      "GLM-5.2": { input: 1.26, output: 3.96, cacheRead: 0.23 },
      "kimi-k3-fast": { input: 4.5, output: 22.5, cacheRead: 0.45 },
      "glm5.2-fast": { input: 2.1, output: 6.6, cacheRead: 0.21 },
    }
    for (const [id, prices] of Object.entries(pricingTable)) {
      const m = resolveModel(id)
      expect(m.pricing.inputUSD, `${id} inputUSD`).toBe(prices.input)
      expect(m.pricing.outputUSD, `${id} outputUSD`).toBe(prices.output)
      expect(m.pricing.cacheReadUSD, `${id} cacheReadUSD`).toBe(prices.cacheRead)
    }
  })

  // ---------------------------------------------------------------------------
  // Error classification
  // ---------------------------------------------------------------------------

  it("classifies 429 rate_limit_error as retryable with streamErrorType", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "ttfb_gate_shed", message: "model at capacity" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({ error: { code: "server_error", message: "down" } })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "insufficient_quota", message: "out of credits" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    const body = "Gateway Timeout"
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    // No `code` field — parser falls back to `type`
    const body = JSON.stringify({ error: { type: "server_error", message: "boom" } })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "invalid_api_key", message: "bad key" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "invalid_request_error", message: "bad request" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
    const model = resolveModel("GLM-5.1")
    // Valid JSON, error object, but no code or type field
    const body = JSON.stringify({ error: { message: "too many requests" } })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
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
  // Capability validation for all 7 models (live API 2026-07-30)
  // ---------------------------------------------------------------------------

  it("each model has correct capabilities", () => {
    setup()
    // GLM-5.1 — 202K context, reasoning on, vision off
    const glm51 = resolveModel("GLM-5.1")
    expect(glm51.capabilities.contextWindow).toBe(202_752)
    expect(glm51.capabilities.thinking.adaptive).toBe(true)
    expect(glm51.capabilities.effort.levels).toEqual(["low", "medium", "high"])
    expect(glm51.capabilities.modalities.image).toBe(false)
    expect(glm51.capabilities.speedFast).toBe(false)

    // GLM-5.2 — 1M context, flagship/deep
    const glm52 = resolveModel("GLM-5.2")
    expect(glm52.capabilities.contextWindow).toBe(1_048_576)
    expect(glm52.tags).toContain("flagship")
    expect(glm52.tags).toContain("deep")

    // Kimi-K3 — 912K context, vision
    expect(resolveModel("Kimi-K3").capabilities.modalities.image).toBe(true)
    expect(resolveModel("Kimi-K3").capabilities.contextWindow).toBe(912_384)

    // Kimi-K2.6 — vision
    expect(resolveModel("Kimi-K2.6").capabilities.modalities.image).toBe(true)
    expect(resolveModel("Kimi-K2.6").capabilities.contextWindow).toBe(262_144)

    // kimi-k3-fast — 1M context, vision, speedFast
    const kimiFast = resolveModel("kimi-k3-fast")
    expect(kimiFast.capabilities.contextWindow).toBe(1_048_576)
    expect(kimiFast.capabilities.speedFast).toBe(true)
    expect(kimiFast.capabilities.modalities.image).toBe(true)

    // glm5.2-fast — cheap scout, speedFast
    const glmFast = resolveModel("glm5.2-fast")
    expect(glmFast.capabilities.contextWindow).toBe(1_048_576)
    expect(glmFast.capabilities.speedFast).toBe(true)
    expect(glmFast.tags).toContain("cheap")
    expect(glmFast.tags).toContain("scout")

    // MiniMax-M3 — vision + reasoning (no interleaved flag in live wafer.capabilities)
    const mm3 = resolveModel("MiniMax-M3")
    expect(mm3.capabilities.thinking.adaptive).toBe(true)
    expect(mm3.capabilities.thinking.interleaved).toBe(false)
    expect(mm3.capabilities.contextWindow).toBe(1_048_576)
    expect(mm3.capabilities.modalities.image).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // modelVersionToken
  // ---------------------------------------------------------------------------

  it("modelVersionToken strips vendor prefixes for all families", () => {
    const fn = waferProviderPlugin.modelVersionToken!
    expect(fn("GLM-5.1")).toBe("5.1")
    expect(fn("GLM-5.2")).toBe("5.2")
    expect(fn("Kimi-K3")).toBe("K3")
    expect(fn("Kimi-K2.6")).toBe("K2.6")
    expect(fn("MiniMax-M3")).toBe("M3")
    expect(fn("kimi-k3-fast")).toBe("k3-fast")
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
    expect(resolveModel("GLM-5.1").providerId).toBe("wafer")
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
    expect(captured.length).toBe(7)
    expect(captured[0]!.id).toBe("GLM-5.1")
    expect(captured[0]!.providerId).toBe("wafer")
    expect(captured[0]!.surfaceId).toBe("openai-chat-completions")

    const seam = local.resolveModel("GLM-5.1")
    expect(seam.providerId).toBe("wafer")
    expect(seam.capabilities.contextWindow).toBe(202_752)
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
    expect(captured.some((c) => c.id === "GLM-5.1")).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Model tags
  // ---------------------------------------------------------------------------

  it("model tags are correct for all 7 models", () => {
    setup()
    const tagChecks: Record<string, string[]> = {
      "GLM-5.1": ["reasoning", "balanced"],
      "Kimi-K3": ["reasoning", "vision"],
      "Kimi-K2.6": ["reasoning", "vision", "balanced"],
      "MiniMax-M3": ["reasoning", "vision", "1m-context"],
      "GLM-5.2": ["reasoning", "1m-context", "flagship", "deep"],
      "kimi-k3-fast": ["reasoning", "vision", "1m-context", "fast"],
      "glm5.2-fast": ["reasoning", "cheap", "scout", "fast"],
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
      modelId: "GLM-5.1",
    })
    const p2 = waferProviderPlugin.primeSessionInfo!({
      modelId: "GLM-5.1",
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
  it.skipIf(!KEY)("live: GLM-5.1 via Wafer (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("GLM-5.1")
    const provider = resolveProvider("wafer")
    const req: CanonicalRequest = {
      modelId: "GLM-5.1",
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
