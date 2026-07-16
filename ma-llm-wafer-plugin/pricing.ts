/**
 * Wafer Serverless pricing tables (USD per 1M tokens).
 *
 * Wafer returns pricing in cents-per-million-tokens from `GET /v1/models`;
 * we convert to USD-per-million for the canonical `MTokRate` shape.
 * This file holds the statically-known rates for the built-in catalog.
 * Rates are sourced from the live API (2026-07-16 snapshot) and should be
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

/** GLM-5.1 — strong bilingual coding + reasoning model.
 *  202K context, vision: no, tools: yes, reasoning: yes, ZDR: yes. */
export const PRICING_GLM_5_1: MTokRate = {
  inputUSD: usd(100),
  outputUSD: usd(320),
  cacheWriteUSD: usd(100),
  cacheReadUSD: usd(10),
  webSearchPerCallUSD: 0,
}

/** GLM-5.2 — 1M context version of GLM-5.1.
 *  1,048,576 context, vision: no, tools: yes, reasoning: yes, ZDR: yes. */
export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: usd(120),
  outputUSD: usd(410),
  cacheWriteUSD: usd(120),
  cacheReadUSD: usd(20),
  webSearchPerCallUSD: 0,
}

/** glm5.2-fast — high-TPS GLM-5.2 SKU (live API 2026-07-16). */
export const PRICING_GLM_5_2_FAST: MTokRate = {
  inputUSD: usd(300),
  outputUSD: usd(1025),
  cacheWriteUSD: usd(300),
  cacheReadUSD: usd(50),
  webSearchPerCallUSD: 0,
}

/** Kimi-K2.6 — sparse MoE, 262K context, vision + tools + reasoning. */
export const PRICING_KIMI_K2_6: MTokRate = {
  inputUSD: usd(114),
  outputUSD: usd(480),
  cacheWriteUSD: usd(114),
  cacheReadUSD: usd(19),
  webSearchPerCallUSD: 0,
}

/** Qwen3.5-397B-A17B — massive MoE, 262K context.
 *  Live API (2026-07-16) omitted pricing; keep last known static rates. */
export const PRICING_QWEN3_5_397B: MTokRate = {
  inputUSD: usd(43),
  outputUSD: usd(260),
  cacheWriteUSD: usd(43),
  cacheReadUSD: usd(4),
  webSearchPerCallUSD: 0,
}

/** MiniMax-M3 — 1M context, vision + inline <think> reasoning, ZDR: no. */
export const PRICING_MINIMAX_M3: MTokRate = {
  inputUSD: usd(33),
  outputUSD: usd(132),
  cacheWriteUSD: usd(33),
  cacheReadUSD: usd(7),
  webSearchPerCallUSD: 0,
}
