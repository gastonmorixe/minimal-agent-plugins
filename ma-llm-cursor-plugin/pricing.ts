/**
 * Pricing rates for Cursor models.
 *
 * Cursor billing is subscription/usage on the Cursor account, not transparent
 * per-1M rates on the wire. Rates are zero so the footer shows token counts
 * without a misleading USD figure until (if) public rates appear.
 *
 * @module llm/providers/cursor/pricing
 */

import type { ModelRate } from "./lib/provider-plugin.ts"

/** Zero-rate pricing for a Cursor model. */
export const PRICING_CURSOR_GENERIC: ModelRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}
