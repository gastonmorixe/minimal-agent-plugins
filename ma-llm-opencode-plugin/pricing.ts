/**
 * OpenCode Go per-model pricing tables (USD per 1M tokens).
 *
 * OpenCode Go is a subscription ($5 first month, then $10/month) with
 * per-token rates that matter for the $12/5h, $30/week, $60/month usage
 * limits. We record the Go list prices so cost estimates reflect real
 * quota burn.
 *
 * Rates sourced from opencode.ai/docs/go and models.dev (2026-07-30 snapshot).
 *
 * @module llm/providers/opencode/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** Generic fallback for ad-hoc models not in the built-in catalog. */
export const PRICING_OPENCODE_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

// OpenAI Chat Completions surface

export const PRICING_DEEPSEEK_V4_PRO: MTokRate = {
  inputUSD: 0.435,
  outputUSD: 0.87,
  cacheWriteUSD: 0, // no explicit cache writes on Chat surface
  cacheReadUSD: 0.003625,
  webSearchPerCallUSD: 0,
}

export const PRICING_DEEPSEEK_V4_FLASH: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

export const PRICING_GLM_5_1: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

export const PRICING_GLM_5: MTokRate = {
  inputUSD: 1.0,
  outputUSD: 3.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

export const PRICING_KIMI_K2_7_CODE: MTokRate = {
  inputUSD: 0.95,
  outputUSD: 4.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.19,
  webSearchPerCallUSD: 0,
}

export const PRICING_KIMI_K2_6: MTokRate = {
  inputUSD: 0.95,
  outputUSD: 4.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.16,
  webSearchPerCallUSD: 0,
}

export const PRICING_KIMI_K2_5: MTokRate = {
  inputUSD: 0.6,
  outputUSD: 3.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0,
}

export const PRICING_KIMI_K3: MTokRate = {
  inputUSD: 3.0,
  outputUSD: 15.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}

export const PRICING_GROK_4_5: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 6.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}

export const PRICING_HY3: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.58,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.035,
  webSearchPerCallUSD: 0,
}

/** Preview slug — same list price as Hy3 until docs publish a distinct rate. */
export const PRICING_HY3_PREVIEW: MTokRate = {
  ...PRICING_HY3,
}

export const PRICING_MIMO_V2_5: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

export const PRICING_MIMO_V2_5_PRO: MTokRate = {
  inputUSD: 0.435,
  outputUSD: 0.87,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.003625,
  webSearchPerCallUSD: 0,
}

export const PRICING_MIMO_V2_PRO: MTokRate = {
  inputUSD: 1.0,
  outputUSD: 3.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

export const PRICING_MIMO_V2_OMNI: MTokRate = {
  inputUSD: 0.4,
  outputUSD: 2.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.08,
  webSearchPerCallUSD: 0,
}

// Anthropic Messages surface

export const PRICING_MINIMAX_M3: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

export const PRICING_MINIMAX_M2_7: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.375, // Messages surface supports cache writes
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

export const PRICING_MINIMAX_M2_5: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.375,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_7_MAX: MTokRate = {
  inputUSD: 2.5,
  outputUSD: 7.5,
  cacheWriteUSD: 3.125,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_7_PLUS: MTokRate = {
  inputUSD: 0.4, // ≤256K tier (covers most agent calls)
  outputUSD: 1.6,
  cacheWriteUSD: 0.5,
  cacheReadUSD: 0.04,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_6_PLUS: MTokRate = {
  inputUSD: 0.5, // ≤256K tier
  outputUSD: 3.0,
  cacheWriteUSD: 0.625,
  cacheReadUSD: 0.05,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_5_PLUS: MTokRate = {
  inputUSD: 0.2,
  outputUSD: 1.2,
  cacheWriteUSD: 0.25,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
}
