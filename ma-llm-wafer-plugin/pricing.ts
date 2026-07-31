/**
 * Wafer Serverless pricing tables (USD per 1M tokens).
 *
 * Wafer returns pricing in cents-per-million-tokens from `GET /v1/models`;
 * we convert to USD-per-million for the canonical `MTokRate` shape.
 * This file holds the statically-known rates for the built-in catalog.
 * Rates are sourced from the live API (2026-07-30 snapshot) and should be
 * refreshed periodically.
 *
 * @module llm/providers/wafer/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** Convert Wafer cents-per-million to USD-per-million. */
function usd(centsPerMil: number): number {
  return centsPerMil / 100
}

/**
 * Generic / unknown-model placeholder rate. Models not in the built-in
 * catalog still work on the wire but show zero cost estimates.
 */
export const PRICING_WAFER_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/** GLM-5.1 — input 100 / output 320 / cache_read 10 cents-per-million. */
export const PRICING_GLM_5_1: MTokRate = {
  inputUSD: usd(100),
  outputUSD: usd(320),
  cacheWriteUSD: usd(100),
  cacheReadUSD: usd(10),
  webSearchPerCallUSD: 0,
}

/** GLM-5.2 — input 126 / output 396 / cache_read 23 cents-per-million. */
export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: usd(126),
  outputUSD: usd(396),
  cacheWriteUSD: usd(126),
  cacheReadUSD: usd(23),
  webSearchPerCallUSD: 0,
}

/** glm5.2-fast — input 210 / output 660 / cache_read 21 cents-per-million. */
export const PRICING_GLM_5_2_FAST: MTokRate = {
  inputUSD: usd(210),
  outputUSD: usd(660),
  cacheWriteUSD: usd(210),
  cacheReadUSD: usd(21),
  webSearchPerCallUSD: 0,
}

/** Kimi-K3 — input 300 / output 1500 / cache_read 30 cents-per-million. */
export const PRICING_KIMI_K3: MTokRate = {
  inputUSD: usd(300),
  outputUSD: usd(1500),
  cacheWriteUSD: usd(300),
  cacheReadUSD: usd(30),
  webSearchPerCallUSD: 0,
}

/** kimi-k3-fast — input 450 / output 2250 / cache_read 45 cents-per-million. */
export const PRICING_KIMI_K3_FAST: MTokRate = {
  inputUSD: usd(450),
  outputUSD: usd(2250),
  cacheWriteUSD: usd(450),
  cacheReadUSD: usd(45),
  webSearchPerCallUSD: 0,
}

/** Kimi-K2.6 — input 114 / output 480 / cache_read 19 cents-per-million. */
export const PRICING_KIMI_K2_6: MTokRate = {
  inputUSD: usd(114),
  outputUSD: usd(480),
  cacheWriteUSD: usd(114),
  cacheReadUSD: usd(19),
  webSearchPerCallUSD: 0,
}

/** MiniMax-M3 — input 33 / output 132 / cache_read 7 cents-per-million. */
export const PRICING_MINIMAX_M3: MTokRate = {
  inputUSD: usd(33),
  outputUSD: usd(132),
  cacheWriteUSD: usd(33),
  cacheReadUSD: usd(7),
  webSearchPerCallUSD: 0,
}
