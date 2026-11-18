import { describe, expect, it } from "bun:test"

import { bootstrapOpencode } from "./adapter.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

function setup() {
  const reg = makeTestRegistry()
  bootstrapOpencode({ models: reg.models, providers: reg.providers })
  return reg
}

// Live /v1/models additions on 2026-11-18 (32 live ids). Caps and pricing: models.dev `opencode-go`.
describe("opencode-go catalog additions (2026-11-18)", () => {
  it("registers hy4 with models.dev caps and pricing", () => {
    const hy4 = setup().resolveModel("hy4")
    expect(hy4.providerId).toBe("opencode-go")
    expect(hy4.surfaceId).toBe("openai-chat-completions")
    expect(hy4.capabilities.contextWindow).toBe(1_048_576)
    expect(hy4.capabilities.maxOutputTokens).toBe(65_536)
    expect(hy4.capabilities.modalities.image).toBe(true)
    expect([...hy4.capabilities.effort.levels]).toEqual(["none", "high"])
    expect(hy4.pricing?.inputUSD).toBe(0.834)
    expect(hy4.pricing?.outputUSD).toBe(2.501)
    expect(hy4.pricing?.cacheReadUSD).toBe(0.042)
  })

  it("registers hy4-flash-free as a free chat model", () => {
    const m = setup().resolveModel("hy4-flash-free")
    expect(m.providerId).toBe("opencode-go")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.capabilities.contextWindow).toBe(1_048_576)
    expect(m.capabilities.maxOutputTokens).toBe(65_536)
    expect(m.capabilities.modalities.image).toBe(true)
    expect([...m.capabilities.effort.levels]).toEqual(["none", "high"])
    expect(m.tags).toContain("free")
    expect(m.pricing?.inputUSD).toBe(0)
    expect(m.pricing?.outputUSD).toBe(0)
  })

  it("registers qwen4-max on the Messages surface with models.dev caps and pricing", () => {
    const m = setup().resolveModel("qwen4-max")
    expect(m.providerId).toBe("opencode-go")
    expect(m.surfaceId).toBe("anthropic-messages")
    expect(m.capabilities.contextWindow).toBe(1_000_000)
    expect(m.capabilities.maxOutputTokens).toBe(262_144)
    expect([...m.capabilities.effort.levels]).toEqual(["none", "low", "high", "xhigh"])
    expect(m.pricing?.inputUSD).toBe(1.5)
    expect(m.pricing?.outputUSD).toBe(4.5)
    expect(m.pricing?.cacheReadUSD).toBe(0.075)
  })

  it("registers longcat-2.5-free as a free chat model", () => {
    const lc = setup().resolveModel("longcat-2.5-free")
    expect(lc.providerId).toBe("opencode-go")
    expect(lc.surfaceId).toBe("openai-chat-completions")
    expect(lc.capabilities.contextWindow).toBe(1_000_000)
    expect(lc.capabilities.maxOutputTokens).toBe(262_144)
    expect(lc.capabilities.modalities.image).toBe(true)
    expect(lc.capabilities.acceptsTemperature).toBe(false)
    expect(lc.tags).toContain("free")
    expect(lc.pricing?.inputUSD).toBe(0)
    expect(lc.pricing?.outputUSD).toBe(0)
  })
})
