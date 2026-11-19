/**
 * Utility model (title SPEC §4.1, §4.3): `recommendUtilityModel()` and the
 * `utility` model tag. Pure: no network, no write to the agent home.
 */

import { describe, expect, it } from "bun:test"

import { ANTHROPIC_UTILITY_MODEL_ORDER, anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import { clearLocalCatalog, findModelByTags, listLocalModels, recordModel } from "./lib/registry.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { ANTHROPIC_HAIKU_45, ANTHROPIC_HAIKU_55 } from "./pricing.ts"
import { useTempAgentHome } from "./test-home.ts"

useTempAgentHome()

function setup() {
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  return reg
}

describe("anthropic recommendUtilityModel", () => {
  it("recommends claude-haiku-5-5 with JSON-schema output, thinking off, effort low, no stream", () => {
    setup()
    expect(anthropicAdapter.recommendUtilityModel()).toEqual({
      modelId: "claude-haiku-5-5",
      structured: "json_schema",
      thinkingOff: true,
      effort: "low",
      stream: "off",
    })
  })

  it("gives the same effort and stream for the Haiku 4.5 fallback", () => {
    setup()
    const keep = listLocalModels().filter((m) => m.id !== "claude-haiku-5-5")
    clearLocalCatalog()
    for (const m of keep) recordModel(m)
    const rec = anthropicAdapter.recommendUtilityModel()
    expect(rec?.effort).toBe("low")
    expect(rec?.stream).toBe("off")
    setup()
  })

  it("keeps the fallback order: Haiku 5.5, then Haiku 4.5", () => {
    expect([...ANTHROPIC_UTILITY_MODEL_ORDER]).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
    ])
  })

  it("falls back to claude-haiku-4-5-20251001 when Haiku 5.5 is not registered", () => {
    setup()
    const keep = listLocalModels().filter((m) => m.id !== "claude-haiku-5-5")
    clearLocalCatalog()
    for (const m of keep) recordModel(m)
    expect(anthropicAdapter.recommendUtilityModel()?.modelId).toBe("claude-haiku-4-5-20251001")
    setup()
  })

  it("returns undefined when no utility candidate is registered", () => {
    clearLocalCatalog()
    expect(anthropicAdapter.recommendUtilityModel()).toBeUndefined()
    setup()
  })

  it("names a model that the host registry has, with the provider anthropic", () => {
    const reg = setup()
    const rec = anthropicAdapter.recommendUtilityModel()
    expect(rec).toBeDefined()
    expect(reg.resolveModel(rec!.modelId).providerId).toBe("anthropic")
  })
})

describe("anthropic utility tag", () => {
  it("tags Haiku 5.5 and Haiku 4.5 only, and the tag lookup picks Haiku 5.5 first", () => {
    setup()
    const tagged = listLocalModels()
      .filter((m) => (m.tags ?? []).includes("utility"))
      .map((m) => m.id)
    expect(tagged).toEqual(["claude-haiku-5-5", "claude-haiku-4-5-20251001"])
    expect(findModelByTags(["utility"])?.id).toBe("claude-haiku-5-5")
  })

  it("sends the tag to the host registry", () => {
    const reg = setup()
    expect(reg.resolveModel("claude-haiku-5-5").tags).toContain("utility")
    expect(reg.resolveModel("claude-haiku-4-5-20251001").tags).toContain("utility")
  })

  it("keeps the price entries of both utility models (docs pricing page)", () => {
    const reg = setup()
    expect(reg.resolveModel("claude-haiku-5-5").pricing).toBe(ANTHROPIC_HAIKU_55)
    expect(reg.resolveModel("claude-haiku-4-5-20251001").pricing).toBe(ANTHROPIC_HAIKU_45)
    expect(ANTHROPIC_HAIKU_55.inputUSD).toBe(0.1)
    expect(ANTHROPIC_HAIKU_55.outputUSD).toBe(0.5)
    expect(ANTHROPIC_HAIKU_45.inputUSD).toBe(1)
    expect(ANTHROPIC_HAIKU_45.outputUSD).toBe(5)
  })
})

describe("main-model selection does not change", () => {
  it("no sonnet, opus or fable model has the utility tag", () => {
    setup()
    for (const m of listLocalModels()) {
      const tags = m.tags ?? []
      if (tags.includes("utility")) expect(tags).toContain("haiku")
    }
  })

  it("recommendSubagentModels gives the same roles as before", () => {
    setup()
    const byRole = new Map(
      (anthropicAdapter.recommendSubagentModels?.() ?? []).map((r) => [r.role, r.modelId]),
    )
    expect(byRole.get("scout")).toBe("claude-haiku-5-5")
    expect(byRole.get("balanced")).toBe("claude-sonnet-5-5")
    expect(byRole.get("deep")).toBe("claude-opus-5-5")
  })

  it("the tier tag lookups keep their first model", () => {
    setup()
    expect(findModelByTags(["haiku", "production"])?.id).toBe("claude-haiku-5-5")
    expect(findModelByTags(["sonnet", "production"])?.id).toBe("claude-sonnet-5-5")
    expect(findModelByTags(["opus", "production"])?.id).toBe("claude-opus-5-5")
    expect(findModelByTags(["fast"])?.id).toBe("claude-haiku-5-5")
  })
})
