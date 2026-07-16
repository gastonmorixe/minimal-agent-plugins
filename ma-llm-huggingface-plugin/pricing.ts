/**
 * HuggingFace Inference Providers pricing (USD per 1M tokens).
 *
 * HuggingFace passes through each backend provider's pricing with no
 * markup. These are best-effort snapshots for the registered slugs;
 * actual pricing varies by backend provider. Models not registered
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

/** openai/gpt-oss-120b via HuggingFace (representative pricing). */
export const PRICING_HF_GPT_OSS_120B: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0.15,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** deepseek-ai/DeepSeek-V4-Flash via HuggingFace (representative, cheap tier). */
export const PRICING_HF_DEEPSEEK_V4_FLASH: MTokRate = {
  inputUSD: 0.1,
  outputUSD: 0.4,
  cacheWriteUSD: 0.1,
  cacheReadUSD: 0.025,
  webSearchPerCallUSD: 0,
}

/** moonshotai/Kimi-K2.7-Code via HuggingFace (representative pricing). */
export const PRICING_HF_KIMI_K2_7_CODE: MTokRate = {
  inputUSD: 0.5,
  outputUSD: 2.0,
  cacheWriteUSD: 0.5,
  cacheReadUSD: 0.125,
  webSearchPerCallUSD: 0,
}

/** zai-org/GLM-5.2 via HuggingFace (representative, flagship tier). */
export const PRICING_HF_GLM_5_2: MTokRate = {
  inputUSD: 0.8,
  outputUSD: 3.2,
  cacheWriteUSD: 0.8,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0,
}

/** MiniMaxAI/MiniMax-M3 via HuggingFace (representative pricing). */
export const PRICING_HF_MINIMAX_M3: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.3,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}
