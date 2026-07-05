// source: core src/llm/pricing.ts (vendored pure cost arithmetic for Wave G self-containment)
/**
 * Pure USD cost arithmetic over a `CanonicalUsage` snapshot at an {@link MTokRate}.
 * Provider-neutral; the plugin ships its own concrete rate tables (pricing.ts).
 * Vendored here so the plugin's pricing tests stay self-contained without a core
 * `src/llm/pricing` import.
 *
 * @module lib/pricing-calc
 */

import type { CanonicalUsage } from "./canonical-events.ts"
import type { MTokRate } from "./host-types.ts"

/** Cost breakdown returned by {@link calculateUsageCost}. */
export interface UsageCost {
  inputUSD: number
  outputUSD: number
  cacheReadUSD: number
  cacheCreationUSD: number
  reasoningUSD: number
  webSearchUSD: number
  totalUSD: number
}

/** Compute USD cost of one usage snapshot at the given rate. Unreported fields are zero. */
export function calculateUsageCost(usage: CanonicalUsage, rate: MTokRate): UsageCost {
  const inputUSD = (usage.inputTokens / 1_000_000) * rate.inputUSD
  const outputUSD = (usage.outputTokens / 1_000_000) * rate.outputUSD
  const cacheReadUSD = ((usage.cacheReadTokens ?? 0) / 1_000_000) * rate.cacheReadUSD
  const cacheCreationUSD = ((usage.cacheCreationTokens ?? 0) / 1_000_000) * rate.cacheWriteUSD
  const reasoningUSD =
    rate.reasoningUSD !== undefined
      ? ((usage.reasoningTokens ?? 0) / 1_000_000) * rate.reasoningUSD
      : 0
  const webSearchUSD = (usage.webSearchRequests ?? 0) * rate.webSearchPerCallUSD
  const totalUSD =
    inputUSD + outputUSD + cacheReadUSD + cacheCreationUSD + reasoningUSD + webSearchUSD
  return {
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheCreationUSD,
    reasoningUSD,
    webSearchUSD,
    totalUSD,
  }
}
