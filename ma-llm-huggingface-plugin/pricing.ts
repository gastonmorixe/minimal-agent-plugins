/**
 * HuggingFace Inference Providers pricing (USD per 1M tokens).
 *
 * HuggingFace passes through each backend provider's pricing with no markup.
 * Rates below are live `/v1/models` snapshots as of **2026-07-30**: for each
 * slug we pick `is_model_author` when that row has pricing, else the live
 * backend with the best `context_length` that `supports_tools`, breaking ties
 * on lowest input USD. Cache write/read are not in the HF payload — write
 * mirrors input and read is input/4 (estimator only). Models not registered
 * here still work on the wire but won't have a local cost estimate.
 *
 * @module llm/providers/huggingface/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** Neutral placeholder for HuggingFace slugs without local pricing. */
export const PRICING_HF_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/** Helper: cache write = input; cache read ≈ input/4 (HF live has no cache rates). */
function rate(inputUSD: number, outputUSD: number): MTokRate {
  return {
    inputUSD,
    outputUSD,
    cacheWriteUSD: inputUSD,
    cacheReadUSD: inputUSD / 4,
    webSearchPerCallUSD: 0,
  }
}

/**
 * openai/gpt-oss-120b — live 2026-07-30, deepinfra \@ 131072 ctx
 * (best-ctx + tools, lowest input among live priced backends).
 */
export const PRICING_HF_GPT_OSS_120B: MTokRate = rate(0.037, 0.17)

/**
 * openai/gpt-oss-20b — live 2026-07-30, deepinfra \@ 131072 ctx.
 */
export const PRICING_HF_GPT_OSS_20B: MTokRate = rate(0.03, 0.14)

/**
 * deepseek-ai/DeepSeek-V4-Flash — live 2026-07-30, deepinfra \@ 1048576 ctx.
 */
export const PRICING_HF_DEEPSEEK_V4_FLASH: MTokRate = rate(0.09, 0.18)

/**
 * deepseek-ai/DeepSeek-V4-Pro — live 2026-07-30, deepinfra \@ 1048576 ctx.
 */
export const PRICING_HF_DEEPSEEK_V4_PRO: MTokRate = rate(1.3, 2.6)

/**
 * moonshotai/Kimi-K2.7-Code — live 2026-07-30, deepinfra \@ 262144 ctx.
 */
export const PRICING_HF_KIMI_K2_7_CODE: MTokRate = rate(0.74, 3.5)

/**
 * moonshotai/Kimi-K3 — live 2026-07-30, fireworks-ai \@ 1048576 ctx
 * (largest live window; together is 1M at the same $/1M).
 */
export const PRICING_HF_KIMI_K3: MTokRate = rate(3, 15)

/**
 * zai-org/GLM-5.2 — live 2026-07-30, deepinfra \@ 1048576 ctx.
 * Author backend `zai-org` is live with tools but omitted pricing/context.
 */
export const PRICING_HF_GLM_5_2: MTokRate = rate(0.75, 2.4)

/**
 * MiniMaxAI/MiniMax-M3 — live 2026-07-30, novita \@ 1000000 ctx
 * (largest window; other live backends share 0.3/1.2 at smaller ctx).
 */
export const PRICING_HF_MINIMAX_M3: MTokRate = rate(0.3, 1.2)
