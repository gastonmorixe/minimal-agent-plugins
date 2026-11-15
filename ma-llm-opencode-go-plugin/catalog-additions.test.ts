import { describe, expect, it } from "bun:test"

import { bootstrapOpencode } from "./adapter.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

function setup() {
  const reg = makeTestRegistry()
  bootstrapOpencode({ models: reg.models, providers: reg.providers })
  return reg
}

// Live /v1/models additions on 2026-11-15. Caps and pricing: models.dev `opencode-go`.
describe("opencode-go catalog additions (2026-11-15)", () => {
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
