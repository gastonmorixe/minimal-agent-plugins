/** OpenCode Zen per-model pricing in USD per 1M tokens. */
import type { MTokRate } from "./lib/host-types.ts"

export const PRICING_OX_ALPHA_FREE: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

export const PRICING_OPENCODE_ZEN_GENERIC: MTokRate = PRICING_OX_ALPHA_FREE
