/**
 * DeepSeek per-model pricing (USD per 1M tokens).
 *
 * Source: DeepSeek API docs "Models & Pricing" (api-docs.deepseek.com),
 * consulted 2026-09-16. DeepSeek publishes OFF-PEAK and PEAK rates; peak is
 * exactly 2x off-peak. Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri.
 * We record the OFF-PEAK (cheaper, majority-hours) rate so the footer's cost
 * estimate is the optimistic bound; double it mentally during peak.
 *
 * DeepSeek context caching is automatic (`prompt_cache_hit_tokens` in usage), so
 * there is no separate cache-write charge: a cache miss is billed as normal
 * input. `cacheReadUSD` is the cache-hit input rate.
 *
 * @module llm/providers/deepseek/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/**
 * `deepseek-flash` (DeepSeek-V4.1-Flash) off-peak. Peak: 0.30 / 1.20 / 0.006.
 */
export const PRICING_DEEPSEEK_FLASH: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0, // automatic caching; a miss is billed as input
  cacheReadUSD: 0.003,
  webSearchPerCallUSD: 0,
}

/**
 * `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) off-peak. Peak: 1.32 / 3.96 / 0.044.
 */
export const PRICING_DEEPSEEK_V4_PRO: MTokRate = {
  inputUSD: 0.66,
  outputUSD: 1.98,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.022,
  webSearchPerCallUSD: 0,
}

/**
 * Fallback for ad-hoc slugs the static catalog doesn't know. Uses the Flash
 * family rate (the cheaper, most likely target of an unknown slug) rather than
 * inventing a figure.
 */
export const PRICING_DEEPSEEK_GENERIC: MTokRate = { ...PRICING_DEEPSEEK_FLASH }
