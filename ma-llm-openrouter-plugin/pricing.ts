/**
 * OpenRouter pricing (USD per 1M tokens).
 *
 * OpenRouter `pricing.*` fields are USD **per token**; multiply by 1e6 for
 * the host `MTokRate` (USD per 1M). `web_search` is already USD per call and
 * maps to `webSearchPerCallUSD` unchanged. Cache read/write are set only when
 * the live row includes them (otherwise 0 — do not invent).
 *
 * Snapshot from GET https://openrouter.ai/api/v1/models as of 2026-11-15.
 * Models not registered here still work on the wire (the CLI doesn't gate on
 * the registry) but won't have a local cost estimate.
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

/** openai/gpt-4o-mini via OpenRouter (2026-11-15). */
export const PRICING_OR_GPT_4O_MINI: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** moonshotai/kimi-k3.1-pro via OpenRouter (2026-11-15). */
export const PRICING_OR_KIMI_K31_PRO: MTokRate = {
  inputUSD: 2,
  outputUSD: 10,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

/** moonshotai/kimi-k2.7-code via OpenRouter (2026-11-15, not curated). */
export const PRICING_OR_KIMI_K27_CODE: MTokRate = {
  inputUSD: 0.6,
  outputUSD: 3.5,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.16,
  webSearchPerCallUSD: 0,
}

/** deepseek/deepseek-v4.1-flash via OpenRouter (2026-11-15). */
export const PRICING_OR_DEEPSEEK_V41_FLASH: MTokRate = {
  inputUSD: 0.0507,
  outputUSD: 0.2028,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.001014,
  webSearchPerCallUSD: 0,
}

/** anthropic/claude-sonnet-5.5 via OpenRouter (2026-11-15). */
export const PRICING_OR_CLAUDE_SONNET_55: MTokRate = {
  inputUSD: 2,
  outputUSD: 10,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0.01,
}

/** anthropic/claude-opus-5.5 via OpenRouter (2026-11-15). */
export const PRICING_OR_CLAUDE_OPUS_55: MTokRate = {
  inputUSD: 4,
  outputUSD: 20,
  cacheWriteUSD: 5,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0.01,
}

/** openai/gpt-6.1-sol via OpenRouter (2026-11-15). Base tier: prompts over 272K tokens bill 4/15 (cache 5/0.2) per the live `overrides` row. */
export const PRICING_OR_GPT_61_SOL: MTokRate = {
  inputUSD: 2,
  outputUSD: 10,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0.01,
}

/** x-ai/grok-4.7 via OpenRouter (2026-11-15). */
export const PRICING_OR_GROK_47: MTokRate = {
  inputUSD: 2,
  outputUSD: 6,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.005,
}
