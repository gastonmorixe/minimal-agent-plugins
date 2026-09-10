/**
 * OpenAI per-model pricing tables (USD per 1M tokens).
 *
 * Source: developers.openai.com/api/docs/pricing (refreshed 2026-09-08;
 * short-context Standard tier). `cacheReadUSD` matches OpenAI's
 * `cached_input` tier. GPT-6 / GPT-5.6 explicit cache writes are 1.25×
 * uncached input; earlier families without a documented write fee mirror
 * input.
 *
 * ChatGPT OAuth model lists do not publish $/MTok — keep pricing on the
 * official API pricing page only. No consumer-slug rows.
 *
 * @module llm/providers/openai/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** gpt-4o standard pricing. */
export const PRICING_GPT_4O: MTokRate = {
  inputUSD: 2.5,
  outputUSD: 10,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 1.25,
  webSearchPerCallUSD: 0,
}

/** gpt-4o-mini standard pricing. */
export const PRICING_GPT_4O_MINI: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0.15,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** gpt-4.1 pricing. */
export const PRICING_GPT_41: MTokRate = {
  inputUSD: 2,
  outputUSD: 8,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/** o3 pricing. Reasoning tokens billed at output rate. */
export const PRICING_O3: MTokRate = {
  inputUSD: 2,
  outputUSD: 8,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
  reasoningUSD: 8,
}

/** o4-mini pricing. */
export const PRICING_O4_MINI: MTokRate = {
  inputUSD: 1.1,
  outputUSD: 4.4,
  cacheWriteUSD: 1.1,
  cacheReadUSD: 0.275,
  webSearchPerCallUSD: 0,
  reasoningUSD: 4.4,
}

/**
 * gpt-5 (legacy) pricing. Source: developers.openai.com/api/docs/models/gpt-5
 * + pricing page (2026-07-30).
 */
export const PRICING_GPT_5: MTokRate = {
  inputUSD: 1.25,
  outputUSD: 10,
  cacheWriteUSD: 1.25,
  cacheReadUSD: 0.125,
  webSearchPerCallUSD: 0,
  reasoningUSD: 10,
}

/** gpt-5.4 standard pricing. */
export const PRICING_GPT_5_4: MTokRate = {
  inputUSD: 2.5,
  outputUSD: 15,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.25,
  webSearchPerCallUSD: 0,
  reasoningUSD: 15,
}

/** gpt-5.4 mini pricing. */
export const PRICING_GPT_5_4_MINI: MTokRate = {
  inputUSD: 0.75,
  outputUSD: 4.5,
  cacheWriteUSD: 0.75,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
  reasoningUSD: 4.5,
}

/** gpt-5.4 nano pricing. */
export const PRICING_GPT_5_4_NANO: MTokRate = {
  inputUSD: 0.2,
  outputUSD: 1.25,
  cacheWriteUSD: 0.2,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
  reasoningUSD: 1.25,
}

/**
 * gpt-5.4 Pro pricing. Pro has no cached input discount.
 * Source: developers.openai.com/api/docs/models/gpt-5.4-pro (2026-07-30).
 */
export const PRICING_GPT_5_4_PRO: MTokRate = {
  inputUSD: 30,
  outputUSD: 180,
  cacheWriteUSD: 30,
  cacheReadUSD: 30,
  webSearchPerCallUSD: 0,
  reasoningUSD: 180,
}

/**
 * gpt-5.5 (Responses + Chat) pricing. $5 in / $30 out per MTok; cached
 * input $0.50. Source: developers.openai.com/api/docs/models/gpt-5.5
 * (2026-07-30). Note the output rate is $30, NOT $25 (Anthropic Opus 4.x).
 * OpenAI bills reasoning tokens at the output rate; automatic prefix
 * caching has no write fee, so `cacheWriteUSD` mirrors input and is never
 * exercised (OpenAI reports `cached_tokens` as reads only).
 */
export const PRICING_GPT_5_5: MTokRate = {
  inputUSD: 5,
  outputUSD: 30,
  cacheWriteUSD: 5,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
  reasoningUSD: 30,
}

/** gpt-5.5 Pro pricing. Pro has no cached input discount. */
export const PRICING_GPT_5_5_PRO: MTokRate = {
  inputUSD: 30,
  outputUSD: 180,
  cacheWriteUSD: 30,
  cacheReadUSD: 30,
  webSearchPerCallUSD: 0,
  reasoningUSD: 180,
}

/**
 * gpt-6-astra pricing. Short-context Standard: $10 / $50 (2026-09-08
 * pricing page + model card). Explicit cache writes are 1.25x uncached
 * input. Long-context (\>272K input) is 2x input/cache and 1.5x output for
 * the full request — not modeled as a separate rate row here.
 */
export const PRICING_GPT_6_ASTRA: MTokRate = {
  inputUSD: 10,
  outputUSD: 50,
  cacheWriteUSD: 12.5,
  cacheReadUSD: 1,
  webSearchPerCallUSD: 0,
  reasoningUSD: 50,
}

/**
 * gpt-5.6 Sol pricing. Short-context Standard promo: $4 / $20 (pricing
 * page 2026-09-08; promo through at least 2026-11-21). Explicit cache
 * writes are 1.25x uncached input.
 */
export const PRICING_GPT_5_6_SOL: MTokRate = {
  inputUSD: 4,
  outputUSD: 20,
  cacheWriteUSD: 5,
  cacheReadUSD: 0.4,
  webSearchPerCallUSD: 0,
  reasoningUSD: 20,
}

/**
 * gpt-5.6 Terra pricing. Short-context Standard: $2 / $12 (2026-07-30
 * pricing page). Explicit cache writes are 1.25x uncached input.
 */
export const PRICING_GPT_5_6_TERRA: MTokRate = {
  inputUSD: 2,
  outputUSD: 12,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
  reasoningUSD: 12,
}

/**
 * gpt-5.6 Luna pricing. Short-context Standard: $0.20 / $1.20 (2026-07-30
 * pricing page). Explicit cache writes are 1.25x uncached input.
 */
export const PRICING_GPT_5_6_LUNA: MTokRate = {
  inputUSD: 0.2,
  outputUSD: 1.2,
  cacheWriteUSD: 0.25,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
  reasoningUSD: 1.2,
}
