/**
 * Token pricing for Grok / xAI models (USD per million tokens).
 *
 * Verified 2026-07-30 live probe (**grok-oauth-9**) against
 * `api.x.ai/v1/models` + language-models merge: price micros
 * (`*_token_price` / 10_000 = USD per 1M). Long-context tiers use
 * `*_token_price_long_context` with `long_context_threshold` 200000.
 * Cross-check: https://docs.x.ai/developers/pricing.
 *
 * Status-bar cost estimates only — xAI also bills tool invocations separately
 * (web_search / x_search $5 per 1k calls; live `search_price` on text SKUs is 0).
 *
 * @module llm/providers/grok/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** Live api.x.ai price fields are in 1e-4 USD per 1M tokens. */
function fromLiveMicros(n: number): number {
  return n / 10_000
}

/**
 * grok-4.6 — frontier. xAI release pricing: prompt $2, cached $0.50,
 * completion $6 below 200k tokens; long-context (≥200k) doubles.
 */
export const PRICING_GROK_46: MTokRate = {
  inputUSD: 2,
  outputUSD: 6,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.005,
  longContext: {
    thresholdTokens: 200_000,
    inputUSD: 4,
    outputUSD: 12,
    cacheWriteUSD: 4,
    cacheReadUSD: 1,
  },
}

/**
 * grok-4.5 — frontier. Live: prompt 20000, cached 3000, completion 60000;
 * long-context (≥200k) doubles.
 */
export const PRICING_GROK_45: MTokRate = {
  inputUSD: fromLiveMicros(20_000), // $2.00
  outputUSD: fromLiveMicros(60_000), // $6.00
  cacheWriteUSD: fromLiveMicros(20_000), // no separate write tier published; ≈ input
  cacheReadUSD: fromLiveMicros(3_000), // $0.30
  webSearchPerCallUSD: 0.005, // $5 / 1k calls
  longContext: {
    thresholdTokens: 200_000,
    inputUSD: fromLiveMicros(40_000), // $4.00
    outputUSD: fromLiveMicros(120_000), // $12.00
    cacheWriteUSD: fromLiveMicros(40_000),
    cacheReadUSD: fromLiveMicros(6_000), // $0.60
  },
}

/**
 * grok-build-0.1 (wire id; local id = `grok-build`).
 * Specialized agentic coding model (May 2026). Live pricing: $1 / $2.
 * Cheaper and faster than frontier models; intended for coding agent loops.
 */
export const PRICING_GROK_BUILD: MTokRate = {
  inputUSD: fromLiveMicros(10_000), // $1.00
  outputUSD: fromLiveMicros(20_000), // $2.00
  cacheWriteUSD: fromLiveMicros(10_000),
  cacheReadUSD: fromLiveMicros(2_000), // $0.20
  webSearchPerCallUSD: 0.005,
  longContext: {
    thresholdTokens: 200_000,
    inputUSD: fromLiveMicros(20_000), // $2.00
    outputUSD: fromLiveMicros(40_000), // $4.00
    cacheWriteUSD: fromLiveMicros(20_000),
    cacheReadUSD: fromLiveMicros(4_000), // $0.40
  },
}

/**
 * grok-4.3 — fast / 1M ctx. Live: 12500 / 2000 / 25000.
 */
export const PRICING_GROK_43: MTokRate = {
  inputUSD: fromLiveMicros(12_500), // $1.25
  outputUSD: fromLiveMicros(25_000), // $2.50
  cacheWriteUSD: fromLiveMicros(12_500),
  cacheReadUSD: fromLiveMicros(2_000), // $0.20
  webSearchPerCallUSD: 0.005,
  longContext: {
    thresholdTokens: 200_000,
    inputUSD: fromLiveMicros(25_000), // $2.50
    outputUSD: fromLiveMicros(50_000), // $5.00
    cacheWriteUSD: fromLiveMicros(25_000),
    cacheReadUSD: fromLiveMicros(4_000), // $0.40
  },
}

/** Same list rates as grok-4.3 for the 4.20 family (live catalog). */
export const PRICING_GROK_420 = PRICING_GROK_43

/** Ad-hoc / unknown models — conservative mid-tier guess. */
export const PRICING_GROK_GENERIC: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 6.0,
  cacheWriteUSD: 2.0,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}
