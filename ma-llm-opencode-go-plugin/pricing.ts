/**
 * OpenCode Go per-model pricing tables (USD per 1M tokens).
 *
 * OpenCode Go is a subscription ($5 first month, then $10/month) with
 * per-token rates that matter for the $12/5h, $30/week, $60/month usage
 * limits. We record the Go list prices so cost estimates reflect real
 * quota burn.
 *
 * Source precedence (2026-11-01):
 * 1. Docs pricing table at `opencode.ai/docs/go` (authoritative Go list rates)
 * 2. models.dev `opencode-go` cost block when docs omit a slug (new or
 *    catalog-only IDs on live `/v1/models`)
 * 3. Clone only for preview siblings with no distinct published rate
 *
 * Conflicts resolved toward docs when both publish a number:
 * - grok-4.6 cache_read: docs $0.50 matches models.dev base ≤200K
 * - glm-5.3-flash: docs $0.15/$0.50/$0.03 vs models.dev $0.075/$0.25/$0.015 → docs
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

/**
 * Source: docs/go Off-Peak tier (2026-09-10). models.dev agrees on Off-Peak base.
 * Docs also publish Peak $1.32/$3.96/$0.044.
 */
export const PRICING_DEEPSEEK_V4_PRO: MTokRate = {
  inputUSD: 0.66,
  outputUSD: 1.98,
  cacheWriteUSD: 0, // no explicit cache writes on Chat surface
  cacheReadUSD: 0.022,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go pricing table (2026-09-07).
 * Note: models.dev is $0.075/$0.25/$0.015 — prefer docs $0.15/$0.50/$0.03.
 */
export const PRICING_GLM_5_3_FLASH: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.5,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.03,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-07-30). models.dev agrees. */
export const PRICING_GLM_5_3: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-08-20). */
export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
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
export const PRICING_KIMI_K3: MTokRate = {
  inputUSD: 3.0,
  outputUSD: 15.0,
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

/** Source: docs/go pricing table (2026-09-07). models.dev agrees. */
export const PRICING_HY4_PREVIEW: MTokRate = {
  inputUSD: 0.834,
  outputUSD: 2.501,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.042,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-09-07). models.dev agrees. */
export const PRICING_LONGCAT_2_0: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.006,
  webSearchPerCallUSD: 0,
}

/** Source: models.dev opencode-go (2026-09-22). */
export const PRICING_MIMO_V2_6_FLASH: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

/** Source: models.dev opencode-go (2026-09-22). */
export const PRICING_MIMO_V2_6_PRO: MTokRate = {
  inputUSD: 0.435,
  outputUSD: 0.87,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.003625,
  webSearchPerCallUSD: 0,
}

/**
 * Source: docs/go Off-Peak tier (2026-09-10). models.dev agrees on Off-Peak base.
 * Docs also publish Peak $0.30/$1.20/$0.006.
 */
export const PRICING_DEEPSEEK_V4_1_FLASH: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.003,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-10-16). Free model has no Go list rate.
 */
export const PRICING_BEAM_FREE: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-10-13): $2/$10/$0.10.
 * No docs/go entry at refresh time; keep the Go list shape.
 */
export const PRICING_GEMINI_4_ARGON: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 10.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-10-24). Free model has no Go list rate.
 */
export const PRICING_ICEMAN_CONTRIBUTOR_FREE: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-10-23): $2/$10/$0.20 cache_read +
 * $2 cache_write.
 */
export const PRICING_KIMI_K3_1_PRO: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 10.0,
  cacheWriteUSD: 2.0,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-10-19): $0.15/$0.60/$0.015.
 */
export const PRICING_MINIMAX_M3_1_FLASH: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.015,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-09-20): $1/$2.70/$0.10.
 */
export const PRICING_STEP_5_PREVIEW: MTokRate = {
  inputUSD: 1.0,
  outputUSD: 2.7,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.1,
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

/** Source: docs/go pricing table (2026-08-05). models.dev agrees. */
export const PRICING_QWEN3_8_MAX: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 6.0,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.25,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-09-07). models.dev agrees. */
export const PRICING_QWEN3_8_FLASH: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.47,
  cacheWriteUSD: 0.2,
  cacheReadUSD: 0.016,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-08-20). No cache writes. */
export const PRICING_MUSE_SPARK_1_2_CONTRIBUTOR: MTokRate = {
  inputUSD: 0.1,
  outputUSD: 0.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.002,
  webSearchPerCallUSD: 0,
}

/** Source: docs/go pricing table (2026-09-07). Same list rate as 1.2 Contributor. */
export const PRICING_MUSE_SPARK_1_3_CONTRIBUTOR: MTokRate = {
  ...PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
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

/**
 * Source: models.dev opencode-go base rate (2026-09-22): $0.10/$0.50/$0.01/$0.125.
 * No docs/go entry at refresh time; docs entry for the 5.6 sibling is kept
 * on the sibling record.
 */
export const PRICING_GPT_6_LUNA: MTokRate = {
  inputUSD: 0.1,
  outputUSD: 0.5,
  cacheWriteUSD: 0.125,
  cacheReadUSD: 0.01,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go base (2026-09-21): $2/$6/$0.50.
 * Docs/go has no 4.7 entry at refresh time; keep the Grok 4.6 docs tiers
 * on that sibling record.
 */
export const PRICING_GROK_4_7: MTokRate = {
  inputUSD: 2.0,
  outputUSD: 6.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/**
 * Source: models.dev opencode-go (2026-10-07), base rate: $0.10/$0.50/$0.01/$0.125.
 * No docs/go entry at refresh time; messages-surface Haiku keeps cache writes.
 */
export const PRICING_CLAUDE_HAIKU_5_5: MTokRate = {
  inputUSD: 0.1,
  outputUSD: 0.5,
  cacheWriteUSD: 0.125,
  cacheReadUSD: 0.01,
  webSearchPerCallUSD: 0,
}
