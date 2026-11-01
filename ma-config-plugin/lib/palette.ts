/**
 * Config overlay style facade.
 *
 * This module keeps the renderer's local names stable. Styles come from the
 * style slots (S41): plain until the CLI runs `ui/setup.ts`. Display width
 * comes from the shared plugin API. The plugin stays host-free.
 *
 * @module config/lib/palette
 */

import {
  displayWidth,
  stripAnsi,
  truncateDisplayWidth,
} from "@minimal-agent/core/plugin-api/utils/term-width"

import { slots } from "./style.ts"

export const SGR = {
  get reset() {
    return slots.codes.RESET
  },
  get bold() {
    return slots.codes.BOLD
  },
  get dim() {
    return slots.codes.DIM
  },
  get italic() {
    return slots.codes.ITALIC
  },
  get underline() {
    return slots.codes.UNDERLINE
  },
  get pink() {
    return slots.palette.pink
  },
  get lime() {
    return slots.palette.lime
  },
  get sky() {
    return slots.palette.sky
  },
  get violet() {
    return slots.palette.violet
  },
  get gold() {
    return slots.palette.gold
  },
  get orange() {
    return slots.palette.orange
  },
  get purple() {
    return slots.palette.purple
  },
  // Standard.
  get red() {
    return slots.palette.red
  },
  get brightRed() {
    return slots.palette.brightRed
  },
  get white() {
    return slots.palette.white
  },
  get faintWhite() {
    return slots.codes.FAINT_WHITE
  },
  get boldWhite() {
    return slots.codes.BOLD_WHITE
  },
  // Dim / bold variants for headers + emphasis.
  get dimLime() {
    return slots.codes.DIM_LIME
  },
  get dimSky() {
    return slots.codes.DIM_SKY
  },
  get dimGold() {
    return slots.codes.DIM_GOLD
  },
  get dimRed() {
    return slots.codes.DIM_RED
  },
  get dimViolet() {
    return slots.codes.DIM_VIOLET
  },
  get boldSky() {
    return slots.codes.BOLD_SKY
  },
  get boldLime() {
    return slots.codes.BOLD_LIME
  },
  get boldRed() {
    return slots.codes.BOLD_BRIGHT_RED
  },
  get boldGold() {
    return slots.codes.BOLD_GOLD
  },
  get boldPink() {
    return slots.codes.BOLD_PINK
  },
} as const

/** Wrap text in an SGR open + reset, with a guard for empty strings. */
export function wrap(text: string, sgr: string): string {
  if (text === "") return ""
  return slots.color(true, sgr, text)
}

/** Wrap with dim. */
export function dim(text: string): string {
  return wrap(text, SGR.dim)
}

/** Strip SGR escapes — needed for visual-width math + tests. */
export function stripSgr(s: string): string {
  return stripAnsi(s)
}

/** Visible cell width using the shared terminal-width model. */
export function visualWidth(s: string): number {
  return displayWidth(s)
}

/** Right-pad to `width` visible cells. */
export function padRight(s: string, width: number, padChar = " "): string {
  const w = visualWidth(s)
  if (w >= width) return s
  return s + padChar.repeat(width - w)
}

/** Truncate to `maxWidth` visible cells with an ellipsis. ANSI-naive: only
 *  call on plain (un-wrapped) text. */
export function truncate(s: string, maxWidth: number): string {
  if (visualWidth(s) <= maxWidth) return s
  if (maxWidth <= 1) return "…"
  return truncateDisplayWidth(s, maxWidth, "…")
}

/**
 * Truncate an ANSI-bearing string to `maxCells` visible width, keeping SGR
 * sequences intact (no half-escapes). Final safety clamp on overlay rows so
 * a wide value never wraps the live area.
 */
export function truncateVisible(s: string, maxCells: number): string {
  return truncateDisplayWidth(s, maxCells, "")
}
