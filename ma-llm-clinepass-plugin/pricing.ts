/**
 * ClinePass reference pricing (USD per 1M tokens).
 *
 * ClinePass is a flat subscription, so these rates are for quota metering and
 * UI cost estimates only, not actual billing. Values prefer official Pass
 * reference pricing from docs.cline.bot/getting-started/clinepass, with catalog
 * fallbacks where docs omit a field. Refreshed 2026-07-30.
 *
 * @module llm/providers/clinepass/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

function rate(inputUSD: number, outputUSD: number, cacheReadUSD = 0, cacheWriteUSD = 0): MTokRate {
  return {
    inputUSD,
    outputUSD,
    cacheWriteUSD,
    cacheReadUSD,
    webSearchPerCallUSD: 0,
  }
}

/** Unknown / ad-hoc model placeholder. */
export const PRICING_CLINEPASS_GENERIC: MTokRate = rate(0, 0)

/** GLM-5.2 — docs: $1.40 / $4.40 / cache read $0.26 */
export const PRICING_GLM_5_2: MTokRate = rate(1.4, 4.4, 0.26)

/** Kimi K3 — docs: $3.00 / $15.00 / $0.30 */
export const PRICING_KIMI_K3: MTokRate = rate(3.0, 15.0, 0.3)

/** Kimi K2.7 Code — docs: $0.95 / $4.00 / $0.19 */
export const PRICING_KIMI_K2_7_CODE: MTokRate = rate(0.95, 4.0, 0.19)

/** Kimi K2.6 — docs: $0.95 / $4.00 / $0.16 */
export const PRICING_KIMI_K2_6: MTokRate = rate(0.95, 4.0, 0.16)

/** DeepSeek V4 Pro — docs: $1.74 / $3.48 / $0.0145 */
export const PRICING_DEEPSEEK_V4_PRO: MTokRate = rate(1.74, 3.48, 0.0145)

/** DeepSeek V4 Flash — docs: $0.14 / $0.28 / $0.0028 */
export const PRICING_DEEPSEEK_V4_FLASH: MTokRate = rate(0.14, 0.28, 0.0028)

/** MiniMax M3 — docs: $0.30 / $1.20 / $0.06 */
export const PRICING_MINIMAX_M3: MTokRate = rate(0.3, 1.2, 0.06)

/** MiMo V2.5 Pro — docs: $1.74 / $3.48 / $0.0145 */
export const PRICING_MIMO_V2_5_PRO: MTokRate = rate(1.74, 3.48, 0.0145)

/** MiMo V2.5 — docs: $0.14 / $0.28 / $0.0028 */
export const PRICING_MIMO_V2_5: MTokRate = rate(0.14, 0.28, 0.0028)

/** Qwen3.7 Max — docs: $2.50 / $7.50 / $0.50 write $3.125 */
export const PRICING_QWEN3_7_MAX: MTokRate = rate(2.5, 7.5, 0.5, 3.125)

/** Qwen3.7 Plus (≤256K tier) — docs: $0.40 / $1.60 / $0.04 write $0.50 */
export const PRICING_QWEN3_7_PLUS: MTokRate = rate(0.4, 1.6, 0.04, 0.5)
