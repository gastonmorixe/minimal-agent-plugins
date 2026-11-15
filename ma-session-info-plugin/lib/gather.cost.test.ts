import { describe, expect, it } from "bun:test"

import { estimateCostUSD } from "./gather.ts"

// Opus 5.5 list rates: https://platform.claude.com/docs/en/about-claude/pricing
const PRICING = { in: 4, out: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 }

describe("estimateCostUSD", () => {
  it("prices the 1h part of cache writes at the 1h rate", () => {
    const cost = estimateCostUSD(
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 1_000_000, cacheCreate1h: 250_000 },
      PRICING,
    )
    expect(cost).toBeCloseTo(0.75 * 5 + 0.25 * 8, 9)
  })

  it("does not price thinking again (it is part of output)", () => {
    const cost = estimateCostUSD(
      { input: 0, output: 1_000_000, cacheRead: 0, cacheCreate: 0, thinking: 400_000 },
      PRICING,
    )
    expect(cost).toBeCloseTo(20, 9)
  })

  it("uses the flat write rate when the model has no 1h tier", () => {
    const { cacheWrite1h: _omit, ...flat } = PRICING
    const cost = estimateCostUSD(
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 1_000_000, cacheCreate1h: 1_000_000 },
      flat,
    )
    expect(cost).toBeCloseTo(5, 9)
  })
})
