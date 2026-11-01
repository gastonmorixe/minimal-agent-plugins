/**
 * Schedule command notice body rows.
 *
 * The host owns notice block chrome (`╭ │ ╰`, title, footer). The schedule
 * plugin only formats domain rows that sit inside that host-rendered block.
 *
 * @module schedule/lib/notice-lines
 */

import { cadenceLabel, clipPrompt, kindGlyph, relativeTime } from "./format.ts"
import { nextFireMs } from "./scheduler.ts"
import type { CronEntry } from "./store.ts"
import { slots } from "./style.ts"

const dim = (s: string) => `${slots.codes.DIM}${s}${slots.codes.RESET}`

/**
 * One colored task row for a `/schedule list` body: bold gold kind glyph, dim
 * id, the cadence, a dim relative next-fire, and a dim clipped prompt.
 */
export function coloredEntryLine(e: CronEntry, now: number): string {
  const next = nextFireMs(e, now)
  const when = next === null ? "—" : relativeTime(next, now)
  const glyph = `${slots.codes.BOLD}${slots.palette.gold}${kindGlyph(e)}${slots.codes.RESET}`
  return (
    `${glyph} ${dim(e.id)}  ${cadenceLabel(e)}  ${dim(`(${when})`)}  ` + dim(clipPrompt(e.prompt))
  )
}
