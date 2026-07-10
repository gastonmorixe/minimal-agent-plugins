/**
 * Token pricing for Grok / xAI models (USD per million tokens).
 *
 * Approximate public list rates for status-bar cost estimates only.
 *
 * @module llm/providers/grok/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** grok-4.5 — frontier tier. */
export const PRICING_GROK_45: MTokRate = {
  inputUSD: 3.0,
  outputUSD: 15.0,
  cacheWriteUSD: 3.75,
  cacheReadUSD: 0.75,
  webSearchPerCallUSD: 0,
}

/** grok-build — coding agent. */
export const PRICING_GROK_BUILD: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 10.0,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/** grok-composer-2.5-fast. */
export const PRICING_GROK_COMPOSER_25_FAST: MTokRate = {
  inputUSD: 0.5,
  outputUSD: 2.0,
  cacheWriteUSD: 0.625,
  cacheReadUSD: 0.125,
  webSearchPerCallUSD: 0,
}

/** Ad-hoc / unknown models. */
export const PRICING_GROK_GENERIC: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 10.0,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}
