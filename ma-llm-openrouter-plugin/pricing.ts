/**
 * OpenRouter pricing (USD per 1M tokens).
 *
 * OpenRouter passes through each upstream model's price; these are
 * best-effort snapshots for the registered slugs (refresh from
 * openrouter.ai/models). Models not registered here still work on the
 * wire (the CLI doesn't gate on the registry) but won't have a local
 * cost estimate.
 *
 * @module llm/providers/openrouter/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** Neutral placeholder for OpenRouter slugs without local pricing. */
export const PRICING_OR_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/** openai/gpt-4o-mini via OpenRouter. */
export const PRICING_OR_GPT_4O_MINI: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0.15,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** moonshotai/kimi-k3 via OpenRouter. */
export const PRICING_OR_KIMI_K3: MTokRate = {
  inputUSD: 3,
  outputUSD: 15,
  cacheWriteUSD: 3,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}

/** moonshotai/kimi-k2.7-code via OpenRouter. */
export const PRICING_OR_KIMI_K27_CODE: MTokRate = {
  inputUSD: 0.75,
  outputUSD: 3.5,
  cacheWriteUSD: 0.75,
  cacheReadUSD: 0.16,
  webSearchPerCallUSD: 0,
}

/** deepseek/deepseek-v4-flash via OpenRouter (cheap scout). */
export const PRICING_OR_DEEPSEEK_V4_FLASH: MTokRate = {
  inputUSD: 0.098,
  outputUSD: 0.196,
  cacheWriteUSD: 0.098,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
}

/** anthropic/claude-sonnet-5 via OpenRouter. */
export const PRICING_OR_CLAUDE_SONNET_5: MTokRate = {
  inputUSD: 2,
  outputUSD: 10,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

/** openai/gpt-5.6-sol via OpenRouter. */
export const PRICING_OR_GPT_56_SOL: MTokRate = {
  inputUSD: 5,
  outputUSD: 30,
  cacheWriteUSD: 5,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/** x-ai/grok-4.5 via OpenRouter. */
export const PRICING_OR_GROK_45: MTokRate = {
  inputUSD: 2,
  outputUSD: 6,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}
