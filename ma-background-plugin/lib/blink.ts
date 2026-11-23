/**
 * Blink and width helpers for the live jobs panel.
 *
 * These helpers are a copy of the helpers in the sub-agents fleet widget
 * (`ma-sub-agents-plugin/lib/widget.ts`). A plugin must not import another
 * plugin, so this plugin keeps its own copy. Keep the two copies the same.
 * The fade of the fleet dot is not copied: the jobs dot changes only its glyph.
 *
 * @module lib/blink
 */

import { truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { slots } from "./style.ts"

/** One blink frame lasts this long. */
export const BLINK_FRAME_MS = 1000

/** The blink rhythm of a row: `period` frames for each cycle, moved by `phase` frames. */
export interface BlinkPattern {
  readonly period: number
  readonly phase: number
}

/** The header dot: a plain on and off cycle of two frames. */
export const HEADER_BLINK: BlinkPattern = { period: 2, phase: 0 }

/** The cycle lengths (in frames) that a row can get. */
const BLINK_PERIODS = [2, 3, 4, 5] as const

/** FNV-1a hash of a string (32 bit). Ids that are different by one char get far values. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The blink rhythm of a row, from a stable hash of the job id. The period and
 * the phase both come from the hash, so the rows do not blink together.
 */
export function blinkPattern(id: string): BlinkPattern {
  const h = fnv1a(id)
  const period = BLINK_PERIODS[h % BLINK_PERIODS.length] ?? 2
  const phase = Math.floor(h / BLINK_PERIODS.length) % period
  return { period, phase }
}

/**
 * The blink dot at `nowMs`, in the sky color. In each cycle of `period`
 * frames, the first `ceil(period / 2)` frames show `●`, the other frames `○`.
 */
export function blinkDot(pattern: BlinkPattern, nowMs: number): string {
  const frame = Math.floor(nowMs / BLINK_FRAME_MS)
  const at = (((frame + pattern.phase) % pattern.period) + pattern.period) % pattern.period
  const on = at < Math.ceil(pattern.period / 2)
  return slots.color(true, slots.palette.sky, on ? "●" : "○")
}

/** Cut `text` to `budget` cells, with `…` at the end. */
export function cut(text: string, budget: number): string {
  if (budget <= 0) return ""
  return truncateDisplayWidth(text, budget, "…")
}
