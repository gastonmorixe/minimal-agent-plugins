/**
 * Meta Muse Spark reference pricing (USD per 1M tokens).
 *
 * Standard / Contributor stickers from https://dev.meta.ai/docs/pricing-rate-limits
 * (Jonathan meta-harness capture 2026-10-04). Contributor trains on your data.
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

/** Unknown / ad-hoc model placeholder (Standard rates). */
export const PRICING_META_GENERIC: MTokRate = rate(1.25, 4.25, 0.15)

/** Standard muse-spark-1.x: $1.25 / $0.15 cached / $4.25. */
const STANDARD = rate(1.25, 4.25, 0.15)

/** Contributor muse-spark-1.x: $0.10 / $0.002 cached / $0.20. */
const CONTRIBUTOR = rate(0.1, 0.2, 0.002)

/** Muse Spark 1.3 — current Standard flagship. */
export const PRICING_MUSE_SPARK_1_3: MTokRate = STANDARD

/** Muse Spark 1.2 — Standard. */
export const PRICING_MUSE_SPARK_1_2: MTokRate = STANDARD

/** Muse Spark 1.1 — Standard. */
export const PRICING_MUSE_SPARK_1_1: MTokRate = STANDARD

/** Muse Spark 1.3 Contributor. */
export const PRICING_MUSE_SPARK_1_3_CONTRIBUTOR: MTokRate = CONTRIBUTOR

/** Muse Spark 1.2 Contributor. */
export const PRICING_MUSE_SPARK_1_2_CONTRIBUTOR: MTokRate = CONTRIBUTOR
