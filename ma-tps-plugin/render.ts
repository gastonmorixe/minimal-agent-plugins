/**
 * Pure renderer for the TPS footer tail.
 *
 * Visual: `42/tps` — faint/dim (style slots, S41), matching the quota-status footer's
 * quiet trailing segments. The number is the dt-weighted EMA rounded by
 * the tracker; this module only styles. No I/O, no env reads.
 *
 * @module tps/render
 */

import { slots } from "./style.ts"

/**
 * Render the tail segment. Returns empty string when inactive or the rate
 * is zero — the caller publishes "" to clear the tail slot.
 */
export function renderTpsTail(tps: number, active: boolean): string {
  if (!active || tps <= 0) return ""
  return `${slots.codes.DIM}${tps}/tps${slots.codes.DIM_CLOSE}`
}
