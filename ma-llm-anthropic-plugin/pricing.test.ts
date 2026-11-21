/**
 * Anthropic pricing-table characterization.
 *
 * The cost arithmetic itself (`calculateUsageCost`) is provider-neutral and
 * tested in `src/llm/llm.test.ts`; this file pins the Anthropic rate DATA
 * (the `Fp` standard rate and the `cx1` 2x fast-tier relationship) that lives
 * in this plugin.
 *
 * @module llm/providers/anthropic/pricing.test
 */

import { describe, expect, it } from "bun:test"

import { calculateUsageCost } from "./lib/pricing-calc.ts"
import { sonnet5RateForDate } from "./models.ts"
import {
  ANTHROPIC_FABLE_5_2,
  ANTHROPIC_HAIKU_55,
  ANTHROPIC_OPUS_4X_STANDARD,
  ANTHROPIC_OPUS_48_FAST,
  ANTHROPIC_OPUS_55_STANDARD,
  ANTHROPIC_SONNET_5_INTRO,
  ANTHROPIC_SONNET_55,
  ANTHROPIC_SONNET_STANDARD,
} from "./pricing.ts"

describe("anthropic pricing tables", () => {
  // 1h write list rates: https://platform.claude.com/docs/en/about-claude/pricing
  it("1h cache write rates match the pricing page", () => {
    expect(ANTHROPIC_FABLE_5_2.cacheWrite1hUSD).toBe(16)
    expect(ANTHROPIC_OPUS_55_STANDARD.cacheWrite1hUSD).toBe(8)
    expect(ANTHROPIC_SONNET_55.cacheWrite1hUSD).toBe(4)
    expect(ANTHROPIC_HAIKU_55.cacheWrite1hUSD).toBe(0.2)
    expect(ANTHROPIC_OPUS_4X_STANDARD.cacheWrite1hUSD).toBe(10)
  })

  it("prices the 1h part of cache writes at the 1h rate", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheBreakdown: { fiveMinute: 500_000, oneHour: 500_000 },
      },
      ANTHROPIC_OPUS_55_STANDARD,
    )
    expect(cost.cacheCreationUSD).toBeCloseTo(0.5 * 5 + 0.5 * 8)
  })

  it("calculateUsageCost matches the documented Fp standard rate", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      },
      ANTHROPIC_OPUS_4X_STANDARD,
    )
    expect(cost.inputUSD).toBeCloseTo(5)
    expect(cost.outputUSD).toBeCloseTo(25)
    expect(cost.cacheReadUSD).toBeCloseTo(0.5)
    expect(cost.cacheCreationUSD).toBeCloseTo(6.25)
    expect(cost.totalUSD).toBeCloseTo(36.75)
  })

  it("the fast rate is 2x standard input/output", () => {
    expect(ANTHROPIC_OPUS_48_FAST.inputUSD).toBe(ANTHROPIC_OPUS_4X_STANDARD.inputUSD * 2)
    expect(ANTHROPIC_OPUS_48_FAST.outputUSD).toBe(ANTHROPIC_OPUS_4X_STANDARD.outputUSD * 2)
  })
})

describe("sonnet 5 introductory pricing", () => {
  it("intro rate is the documented $2 / $10 per Mtok", () => {
    expect(ANTHROPIC_SONNET_5_INTRO.inputUSD).toBe(2)
    expect(ANTHROPIC_SONNET_5_INTRO.outputUSD).toBe(10)
  })

  it("standard rate (post-2026-09-01) is the documented $3 / $15 per Mtok", () => {
    expect(ANTHROPIC_SONNET_STANDARD.inputUSD).toBe(3)
    expect(ANTHROPIC_SONNET_STANDARD.outputUSD).toBe(15)
  })

  it("applies the intro rate before the 2026-09-01 cutover", () => {
    // Launch day and the last intro day (2026-08-31) both get intro pricing.
    expect(sonnet5RateForDate(Date.UTC(2026, 5, 30))).toBe(ANTHROPIC_SONNET_5_INTRO)
    expect(sonnet5RateForDate(Date.UTC(2026, 7, 31, 23, 59, 59))).toBe(ANTHROPIC_SONNET_5_INTRO)
  })

  it("switches to the standard rate at the 2026-09-01 boundary and after", () => {
    expect(sonnet5RateForDate(Date.UTC(2026, 8, 1, 0, 0, 0))).toBe(ANTHROPIC_SONNET_STANDARD)
    expect(sonnet5RateForDate(Date.UTC(2026, 11, 25))).toBe(ANTHROPIC_SONNET_STANDARD)
  })
})
