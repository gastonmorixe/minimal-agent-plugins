/**
 * OpenCode Go per-model pricing tables (USD per 1M tokens).
 *
 * OpenCode Go is a subscription ($5 first month, then $10/month) with
 * per-token rates that matter for the $12/5h, $30/week, $60/month usage
 * limits. We record the Go list prices so cost estimates reflect real
 * quota burn.
 *
 * Source precedence (2026-08-05):
 * 1. Docs pricing table at `opencode.ai/docs/go` (authoritative Go list rates)
 * 2. models.dev `opencode-go` cost block when docs omit a slug (deprecated /
 *    catalog-only IDs still on live `/v1/models`)
 * 3. Clone only for preview siblings with no distinct published rate
 *
 * Conflicts resolved toward docs when both publish a number:
 * - grok-4.5 cache_read: docs $0.30 vs models.dev $0.50 → docs
 * - minimax-m2.5 cache_read: docs $0.06 vs models.dev $0.03 → docs
 * - minimax-m2.7 / m2.5 cache_write: docs only → docs
 * - gpt-5.6-luna ≤272K: docs $0.20/$1.20/$0.02/$0.25 vs models.dev
 *   $0.10/$0.60/$0.01/$0.125 → docs (keep base Go list rate)
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

/** Source: docs/go pricing table (2026-07-30). models.dev agrees on input/output/cache_read. */
export const PRICING_DEEPSEEK_V4_PRO: MTokRate = {
  inputUSD: 0.435,
  outputUSD: 0.87,
  cacheWriteUSD: 0, // no explicit cache writes on Chat surface
  cacheReadUSD: 0.003625,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_DEEPSEEK_V4_FLASH: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_GLM_5_1: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-07-30). Not on docs/go pricing table
 * (deprecated / catalog-only; still on live `/v1/models`).
 */
export const PRICING_GLM_5: MTokRate = {
  inputUSD: 1.0,
  outputUSD: 3.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_KIMI_K2_7_CODE: MTokRate = {
  inputUSD: 0.95,
  outputUSD: 4.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.19,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_KIMI_K2_6: MTokRate = {
  inputUSD: 0.95,
  outputUSD: 4.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.16,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-07-30). Not on docs/go pricing table
 * (deprecated; still on live `/v1/models`).
 */
export const PRICING_KIMI_K2_5: MTokRate = {
  inputUSD: 0.6,
  outputUSD: 3.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_KIMI_K3: MTokRate = {
  inputUSD: 3.0,
  outputUSD: 15.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go pricing table (2026-07-30).
 * Note: models.dev cache_read is $0.50; docs list $0.30 — prefer docs.
 * models.dev also publishes \>200K tier ($4/$12/$1); we keep base Go list rate.
 */
export const PRICING_GROK_4_5: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 6.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_HY3: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.58,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.035,
  webSearchPerCallUSD: 0,
}

/**
 * Preview slug on live `/v1/models` only — absent from docs/go and models.dev.
 * Cloned from Hy3 list price (same family) until a distinct rate is published.
 */
export const PRICING_HY3_PREVIEW: MTokRate = {
  ...PRICING_HY3,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_MIMO_V2_5: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_MIMO_V2_5_PRO: MTokRate = {
  inputUSD: 0.435,
  outputUSD: 0.87,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.003625,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-07-30). Not on docs/go pricing table
 * (deprecated; still on live `/v1/models`).
 */
export const PRICING_MIMO_V2_PRO: MTokRate = {
  inputUSD: 1.0,
  outputUSD: 3.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-07-30). Not on docs/go pricing table
 * (deprecated; still on live `/v1/models`).
 */
export const PRICING_MIMO_V2_OMNI: MTokRate = {
  inputUSD: 0.4,
  outputUSD: 2.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.08,
  webSearchPerCallUSD: 0,
}

// Anthropic Messages surface

/** Source: docs/go pricing table (2026-07-30). models.dev agrees (no cache_write). */
export const PRICING_MINIMAX_M3: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go pricing table (2026-07-30) including cache_write $0.375.
 * models.dev omits cache_write; prefer docs.
 */
export const PRICING_MINIMAX_M2_7: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.375,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go pricing table (2026-07-30) including cache_write $0.375.
 * Note: models.dev cache_read is $0.03; docs list $0.06 — prefer docs.
 */
export const PRICING_MINIMAX_M2_5: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.375,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_QWEN3_7_MAX: MTokRate = {
  inputUSD: 2.5,
  outputUSD: 7.5,
  cacheWriteUSD: 3.125,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go ≤256K tier (2026-07-30); covers most agent calls.
 * Docs + models.dev also publish \>256K tier ($1.20/$4.80/$0.12/$1.50).
 */
export const PRICING_QWEN3_7_PLUS: MTokRate = {
  inputUSD: 0.4,
  outputUSD: 1.6,
  cacheWriteUSD: 0.5,
  cacheReadUSD: 0.04,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go ≤256K tier (2026-07-30).
 * Docs also publish \>256K tier ($2.00/$6.00/$0.20/$2.50).
 */
export const PRICING_QWEN3_6_PLUS: MTokRate = {
  inputUSD: 0.5,
  outputUSD: 3.0,
  cacheWriteUSD: 0.625,
  cacheReadUSD: 0.05,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-07-30). Not on docs/go pricing table
 * (deprecated; still on live `/v1/models`).
 */
export const PRICING_QWEN3_5_PLUS: MTokRate = {
  inputUSD: 0.2,
  outputUSD: 1.2,
  cacheWriteUSD: 0.25,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-08-05). models.dev agrees. */
export const PRICING_QWEN3_8_MAX: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 6.0,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.25,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go ≤272K tier (2026-08-05); covers most agent calls.
 * Docs also publish \>272K tier ($0.40/$1.80/$0.04/$0.50).
 * Note: models.dev base is $0.10/$0.60/$0.01/$0.125 — prefer docs.
 */
export const PRICING_GPT_5_6_LUNA: MTokRate = {
  inputUSD: 0.2,
  outputUSD: 1.2,
  cacheWriteUSD: 0.25,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
}
