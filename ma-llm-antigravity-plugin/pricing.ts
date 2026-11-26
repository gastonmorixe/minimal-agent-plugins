/**
 * Pricing table for the Antigravity models.
 *
 * Antigravity is a Google AI plan subscription: the account pays for the plan,
 * not per token, and the quota is reported by `retrieveUserQuotaSummary`. The
 * backend sends no price field. All rates are therefore zero, and the UI shows
 * a plan line instead of a dollar estimate.
 *
 * No unverified dollar figure is put here on purpose: a wrong rate is worse
 * than a zero rate on a plan that does not bill per token.
 *
 * @module llm/providers/antigravity/pricing
 */

import type { MTokRate } from "./lib/host-types.ts"

/** Zero rate for every model of the plan. */
export const PRICING_ANTIGRAVITY_PLAN: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/** Rate of a model that is not in the plan (an ad-hoc or unknown id). */
export const PRICING_ANTIGRAVITY_UNKNOWN: MTokRate = { ...PRICING_ANTIGRAVITY_PLAN }
