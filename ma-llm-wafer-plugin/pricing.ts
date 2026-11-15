/**
 * Wafer Serverless pricing tables (USD per 1M tokens).
 *
 * Wafer returns pricing in cents-per-million-tokens from `GET /v1/models`;
 * we convert to USD-per-million for the canonical `MTokRate` shape.
 * This file holds the statically-known rates for the built-in catalog.
 * Rates are sourced from the live API (2026-11-15 snapshot) and should be
 * refreshed periodically. When the live block carries
 * `cache_read_microcents_per_million`, the cache-read rate uses that finer
 * value (the rounded `cache_read_cents_per_million` can differ by up to 0.5).
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

/** GLM-5.2 — input 19 / output 440 / cache_read 18 cents-per-million. */
export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: usd(19),
  outputUSD: usd(440),
  cacheWriteUSD: usd(19),
  cacheReadUSD: usd(18),
  webSearchPerCallUSD: 0,
}

/** GLM-5.3 — input 20 / output 180 / cache_read 18 cents-per-million. */
export const PRICING_GLM_5_3: MTokRate = {
  inputUSD: usd(20),
  outputUSD: usd(180),
  cacheWriteUSD: usd(20),
  cacheReadUSD: usd(18),
  webSearchPerCallUSD: 0,
}

/** GLM-5.3-Flash — input 5 / output 20 / cache_read 3 cents-per-million. */
export const PRICING_GLM_5_3_FLASH: MTokRate = {
  inputUSD: usd(5),
  outputUSD: usd(20),
  cacheWriteUSD: usd(5),
  cacheReadUSD: usd(3),
  webSearchPerCallUSD: 0,
}

/** Kimi-K3 — input 60 / output 1500 / cache_read 20 cents-per-million. */
export const PRICING_KIMI_K3: MTokRate = {
  inputUSD: usd(60),
  outputUSD: usd(1500),
  cacheWriteUSD: usd(60),
  cacheReadUSD: usd(20),
  webSearchPerCallUSD: 0,
}

/** Kimi-K3.1-Pro (+ Kimi-K3.1-Pro-US, same live rates) — input 200 / output 1000 / cache_read 20 cents-per-million. */
export const PRICING_KIMI_K3_1_PRO: MTokRate = {
  inputUSD: usd(200),
  outputUSD: usd(1000),
  cacheWriteUSD: usd(200),
  cacheReadUSD: usd(20),
  webSearchPerCallUSD: 0,
}

/** MiniMax-M3.1-Flash — input 15 / output 60 / cache_read 1.5 cents-per-million. */
export const PRICING_MINIMAX_M3_1_FLASH: MTokRate = {
  inputUSD: usd(15),
  outputUSD: usd(60),
  cacheWriteUSD: usd(15),
  cacheReadUSD: usd(1.5),
  webSearchPerCallUSD: 0,
}

/** DeepSeek-V4-Pro — input 28 / output 396 / cache_read 4.4 cents-per-million. */
export const PRICING_DEEPSEEK_V4_PRO: MTokRate = {
  inputUSD: usd(28),
  outputUSD: usd(396),
  cacheWriteUSD: usd(28),
  cacheReadUSD: usd(4.4),
  webSearchPerCallUSD: 0,
}

/** DeepSeek-V4.1-Flash — input 19 / output 65 / cache_read 1.2 cents-per-million. */
export const PRICING_DEEPSEEK_V4_1_FLASH: MTokRate = {
  inputUSD: usd(19),
  outputUSD: usd(65),
  cacheWriteUSD: usd(19),
  cacheReadUSD: usd(1.2),
  webSearchPerCallUSD: 0,
}

/** DeepSeek-V4.1-Flash-1017 — input 13 / output 50 / cache_read 0.8 cents-per-million. */
export const PRICING_DEEPSEEK_V4_1_FLASH_1017: MTokRate = {
  inputUSD: usd(13),
  outputUSD: usd(50),
  cacheWriteUSD: usd(13),
  cacheReadUSD: usd(0.8),
  webSearchPerCallUSD: 0,
}

/** DeepSeek-V4-Flash-0423 — input 14 / output 28 / cache_read 2.8 cents-per-million. */
export const PRICING_DEEPSEEK_V4_FLASH_0423: MTokRate = {
  inputUSD: usd(14),
  outputUSD: usd(28),
  cacheWriteUSD: usd(14),
  cacheReadUSD: usd(2.8),
  webSearchPerCallUSD: 0,
}

/** DeepSeek-V4-Flash-0731-Fast — input 13 / output 23 / cache_read 2.8 cents-per-million. */
export const PRICING_DEEPSEEK_V4_FLASH_0731_FAST: MTokRate = {
  inputUSD: usd(13),
  outputUSD: usd(23),
  cacheWriteUSD: usd(13),
  cacheReadUSD: usd(2.8),
  webSearchPerCallUSD: 0,
}

/** Qwen3.8-27B — input 6 / output 230 / cache_read 5 cents-per-million. */
export const PRICING_QWEN3_8_27B: MTokRate = {
  inputUSD: usd(6),
  outputUSD: usd(230),
  cacheWriteUSD: usd(6),
  cacheReadUSD: usd(5),
  webSearchPerCallUSD: 0,
}
