/**
 * Meta Muse Spark reference pricing (USD per 1M tokens).
 *
 * Sourced from the live `dev.meta.ai` Models page (2026-08-05 dashboard
 * capture). Contributor SKU is cheaper and trains on your data.
 *
 * @module llm/providers/meta/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

function rate(inputUSD: number, outputUSD: number, cacheReadUSD = 0, cacheWriteUSD = 0): MTokRate {
  return {
    inputUSD,
    outputUSD,
    cacheWriteUSD,
    cacheReadUSD,
    webSearchPerCallUSD: 0,
  }
}

/** Unknown / ad-hoc model placeholder. */
export const PRICING_META_GENERIC: MTokRate = rate(1.25, 4.25, 0.15)

/**
 * Muse Spark 1.2 — dashboard: $1.25 / $0.15 cached / $4.25.
 * Same sticker as 1.1.
 */
export const PRICING_MUSE_SPARK_1_2: MTokRate = rate(1.25, 4.25, 0.15)

/** Muse Spark 1.1 — dashboard: $1.25 / $0.15 cached / $4.25. */
export const PRICING_MUSE_SPARK_1_1: MTokRate = rate(1.25, 4.25, 0.15)

/**
 * Muse Spark 1.2 Contributor — dashboard: $0.10 / $0.002 cached / $0.20.
 * Trains on your data; lower RPM (60) / TPM (2.1M).
 */
export const PRICING_MUSE_SPARK_1_2_CONTRIBUTOR: MTokRate = rate(0.1, 0.2, 0.002)
