/**
 * Anthropic per-model pricing tables (USD per 1M tokens).
 *
 * The rate DATA lives in this provider plugin; core keeps only the generic
 * {@link MTokRate} shape and the neutral `calculateUsageCost` / `mergeUsage`
 * arithmetic. Source: `cli.patched.cjs` L116516+ in claude-code 2.1.154 and
 * `private/research/2026-05-28-llm-providers/00-research-notes.md`.
 *
 * @module llm/providers/anthropic/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/**
 * Anthropic's `Fp` rate : opus 4.5 / 4.6 / 4.7 / 4.8 standard pricing.
 * Verified against `cli.patched.cjs` L116516 in claude-code 2.1.154.
 */
export const ANTHROPIC_OPUS_4X_STANDARD: MTokRate = {
  inputUSD: 5,
  outputUSD: 25,
  cacheWriteUSD: 6.25,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Opus 5.5 (`claude-opus-5-5`) standard rate : $4 / 1M input,
 * $20 / 1M output. 20% below Opus 5. Cache reads are $0.20/M, which is
 * 0.05x input (half the usual 0.1x schedule) per the pricing page footnote.
 *
 * Verified two ways on 2026-09-22: the platform.claude.com/docs pricing
 * table, and the claude-code 2.1.280 baked catalog, whose tier is named
 * `tier_4_20_cache_read_0_20` and whose rate object reads:
 *
 * ```js
 * {inputTokens:4, outputTokens:20, promptCacheWriteTokens:5,
 *  promptCacheWrite1hTokens:8, promptCacheReadTokens:0.2}
 * ```
 *
 * The 1h cache-write rate ($8/M) has no slot in {@link MTokRate}, so only
 * the 5m rate is carried here.
 */
export const ANTHROPIC_OPUS_55_STANDARD: MTokRate = {
  inputUSD: 4,
  outputUSD: 20,
  cacheWriteUSD: 5,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Opus 5.5 with `speed:"fast"` : 2x standard, matching the Opus 4.8
 * fast multiplier. $8 / 1M input, $40 / 1M output.
 *
 * Source: the claude-code 2.1.280 rate object returned for
 * `claude-opus-5-5` when `speed === "fast"`:
 *
 * ```js
 * {inputTokens:8, outputTokens:40, promptCacheWriteTokens:10,
 *  promptCacheWrite1hTokens:16, promptCacheReadTokens:0.4}
 * ```
 *
 * Matches the fast-mode pricing on the docs site.
 */
export const ANTHROPIC_OPUS_55_FAST: MTokRate = {
  inputUSD: 8,
  outputUSD: 40,
  cacheWriteUSD: 10,
  cacheReadUSD: 0.4,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `cx1` rate : opus 4.8 with `speed:"fast"`. 2× standard.
 * Verified against `cli.patched.cjs` L116530.
 */
export const ANTHROPIC_OPUS_48_FAST: MTokRate = {
  inputUSD: 10,
  outputUSD: 50,
  cacheWriteUSD: 12.5,
  cacheReadUSD: 1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Fable 5 rate : the public Mythos-class model released 2026-06-09.
 * $10 / 1M input, $50 / 1M output (0.4x the gated Mythos Preview's $25/$125),
 * with the standard 1.25x cache-write / 0.1x cache-read multipliers. There is
 * no `speed:"fast"` tier for this model, so a single flat rate applies.
 * Numerically identical to ANTHROPIC_OPUS_48_FAST; kept as a separate table
 * because the two rates move independently (one is a fast-tier surcharge,
 * this is a base rate).
 */
export const ANTHROPIC_FABLE_5: MTokRate = {
  inputUSD: 10,
  outputUSD: 50,
  cacheWriteUSD: 12.5,
  cacheReadUSD: 1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Fable 5.1 rate : live 2026-08-28 per `GET /v1/models`.
 * Same $10/$50 base + $12.50 cache-write as Fable 5, but cache reads drop
 * to $0.25/M (2.5% of input vs the standard 10%).
 * Source: https://www.anthropic.com/claude/fable (verified 2026-09-14).
 */
export const ANTHROPIC_FABLE_5_1: MTokRate = {
  inputUSD: 10,
  outputUSD: 50,
  cacheWriteUSD: 12.5,
  cacheReadUSD: 0.25,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Fable 5.2 base rate : $8 / 1M input, $40 / 1M output. 20% below
 * Fable 5.1 despite being the newer model. Cache reads are $0.20/M (0.025x
 * input, the Fable-5.2-and-later multiplier), cache writes $10/M at the
 * standard 1.25x schedule.
 *
 * Source, verified 2026-11-13 two ways:
 *   - the platform pricing table (`Claude Fable 5.2 | $8 / MTok | $40 / MTok |
 *     $10 / MTok | $16 / MTok | $0.20 / MTok`), plus the cache-hit multiplier
 *     note ("Claude Fable 5.2 and Claude Mythos 5.2 | 0.025x");
 *   - the claude-code 2.1.323 baked catalog, tier
 *     `tier_8_40_cache_read_0_20` = `{input:8, output:40, cache_write_5m:10,
 *     cache_write_1h:16, cache_read:0.2, web_search:0.01}`.
 */
export const ANTHROPIC_FABLE_5_2: MTokRate = {
  inputUSD: 8,
  outputUSD: 40,
  cacheWriteUSD: 10,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Fable 5.2 with `speed:"fast"` : 2x the base rate, $16 / 1M input and
 * $80 / 1M output, with cache reads held at $0.20/M.
 *
 * Source: the pricing page fast-mode table (`Claude Fable 5.2 | $16 USD / MTok
 * | $80 USD / MTok`) and the 2.1.323 binary's `kA` constant, the rate the CLI
 * bills for `claude-fable-5-2` when `speed==="fast"`: `{inputTokens:16,
 * outputTokens:80, promptCacheWriteTokens:20, promptCacheWrite1hTokens:32,
 * promptCacheReadTokens:0.4}`.
 *
 * The fast cache-read rate in the bundle is 0.4, i.e. 0.025x of the FAST input
 * rate, matching how the base tier's 0.2 is 0.025x of 8. The pricing page only
 * prints the token columns for fast mode, so both readings agree on the two
 * numbers the page documents.
 */
export const ANTHROPIC_FABLE_5_2_FAST: MTokRate = {
  inputUSD: 16,
  outputUSD: 80,
  cacheWriteUSD: 20,
  cacheReadUSD: 0.4,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `dx1` rate : opus 4.5/4.6/4.7 with `speed:"fast"`. 6× standard.
 * Verified against `cli.patched.cjs` L116523.
 */
export const ANTHROPIC_OPUS_4X_FAST_LEGACY: MTokRate = {
  inputUSD: 30,
  outputUSD: 150,
  cacheWriteUSD: 37.5,
  cacheReadUSD: 3,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `vKH` rate : sonnet 3.5 / 3.7 / 4 / 4.5 / 4.6, and the
 * post-introductory standard rate for sonnet 5 (effective 2026-09-01).
 * $3 / 1M input, $15 / 1M output.
 */
export const ANTHROPIC_SONNET_STANDARD: MTokRate = {
  inputUSD: 3,
  outputUSD: 15,
  cacheWriteUSD: 3.75,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Sonnet 5 INTRODUCTORY rate : $2 / 1M input, $10 / 1M output, in
 * effect from launch (2026-06-30) through 2026-08-31. On 2026-09-01 the
 * model reverts to {@link ANTHROPIC_SONNET_STANDARD} ($3 / $15). Per the
 * launch announcement (https://www.anthropic.com/news/claude-sonnet-5):
 * "introductory pricing of $2 per million input tokens and $10 per million
 * output tokens through August 31, 2026, after which it will be priced at
 * $3 per million input tokens and $15 per million output tokens."
 *
 * Cache multipliers follow Anthropic's standard schedule (cache-write =
 * 1.25x input, cache-read = 0.1x input): $2.50 write, $0.20 read. The
 * date-based switch between this and the standard rate is implemented by
 * {@link sonnet5PricingFor} in `models.ts`.
 */
export const ANTHROPIC_SONNET_5_INTRO: MTokRate = {
  inputUSD: 2,
  outputUSD: 10,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Sonnet 5.5 (`claude-sonnet-5-5`) standard rate : $2 / 1M input,
 * $10 / 1M output with cache reads at $0.10/M (0.05x input) and cache writes
 * at $2.50/M. The 2026-09-28 launch post-dates the Sonnet 5 cutover, so this
 * is the model's own tier and not the Sonnet 5 post-intro rate: the pricing
 * page lists Sonnet 5.5 at $2/$10 alongside Sonnet 5, and its cache-hit
 * multiplier is 0.05x rather than the standard 0.1x.
 *
 * Verified 2026-11-13 against the pricing table (`Claude Sonnet 5.5 | $2 /
 * MTok | $10 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok`), the
 * cache-hit multiplier table (`Claude Sonnet 5.5 | 0.05x | $0.10 USD`), and
 * the 2.1.323 baked catalog tier `tier_2_10_cache_read_0_10`
 * (`{input:2, output:10, cache_write_5m:2.5, cache_write_1h:4,
 * cache_read:0.1}`).
 */
export const ANTHROPIC_SONNET_55: MTokRate = {
  inputUSD: 2,
  outputUSD: 10,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Haiku 5.5 (`claude-haiku-5-5`) base rate for prompts up to 100,000
 * tokens: $0.10 / 1M input, $0.50 / 1M output. This is a 10x drop from Haiku
 * 4.5 and the cheapest tier in the catalog.
 *
 * Haiku 5.5 is the ONE model priced by prompt length: a request whose prompt
 * (input + cache reads + cache writes) exceeds 100k tokens pays
 * {@link ANTHROPIC_HAIKU_55_LONG_PROMPT} instead. Pricing is per request, so a
 * long request pays the higher rate even when most of it is a cache hit.
 * {@link haiku55RateForInputTokens} picks between the two.
 *
 * Verified 2026-11-13 against the pricing table (`$0.10 / MTok for prompts up
 * to 100,000 tokens`), the long-context section, and the 2.1.323 baked tier
 * `haiku_55` (`{input:0.1, output:0.5, cache_write_5m:0.125,
 * cache_write_1h:0.2, cache_read:0.01, long_prompt:{above_prompt_tokens:1e5,
 * input:0.5, output:2.5, cache_write_5m:0.625, cache_read:0.05}}`).
 */
export const ANTHROPIC_HAIKU_55: MTokRate = {
  inputUSD: 0.1,
  outputUSD: 0.5,
  cacheWriteUSD: 0.125,
  cacheReadUSD: 0.01,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Haiku 5.5 long-prompt rate, applied when a single request's prompt
 * exceeds {@link HAIKU_55_LONG_PROMPT_THRESHOLD} tokens: $0.50 / 1M input,
 * $2.50 / 1M output (5x the base rate, matching the documented step).
 *
 * The 1h cache-write rate ($1/M) has no slot in {@link MTokRate}, so only the
 * 5m rate is carried.
 */
export const ANTHROPIC_HAIKU_55_LONG_PROMPT: MTokRate = {
  inputUSD: 0.5,
  outputUSD: 2.5,
  cacheWriteUSD: 0.625,
  cacheReadUSD: 0.05,
  webSearchPerCallUSD: 0.01,
}

/**
 * Prompt length above which Haiku 5.5 switches to its long-prompt rate.
 * Strictly greater than: a 100,000-token prompt still pays the base rate.
 */
export const HAIKU_55_LONG_PROMPT_THRESHOLD = 100_000

/**
 * Anthropic's `l78` rate : haiku 4.5.
 */
export const ANTHROPIC_HAIKU_45: MTokRate = {
  inputUSD: 1,
  outputUSD: 5,
  cacheWriteUSD: 1.25,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `c78` rate : haiku 3.5.
 */
export const ANTHROPIC_HAIKU_35: MTokRate = {
  inputUSD: 0.8,
  outputUSD: 4,
  cacheWriteUSD: 1,
  cacheReadUSD: 0.08,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `_Y9` rate : opus 4.0 / 4.1 (legacy).
 */
export const ANTHROPIC_OPUS_40_41: MTokRate = {
  inputUSD: 15,
  outputUSD: 75,
  cacheWriteUSD: 18.75,
  cacheReadUSD: 1.5,
  webSearchPerCallUSD: 0.01,
}
