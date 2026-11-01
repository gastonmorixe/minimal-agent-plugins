/**
 * Mention overlay style facade.
 *
 * Styles come from the style slots (S41). They are plain until the CLI runs
 * `ui/setup.ts`, which installs the CLI terminal kit.
 *
 */

import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { slots } from "../style-slots.ts"

const SGR_KEYS = [
  "reset",
  "bold",
  "dim",
  "fgReset",
  "pink",
  "lime",
  "sky",
  "violet",
  "gold",
  "orange",
  "purple",
  "red",
  "brightRed",
  "white",
  "faintWhite",
  "boldWhite",
  "dimLime",
  "dimSky",
  "dimGold",
  "dimRed",
  "boldSky",
  "boldLime",
  "boldRed",
  "boldGold",
  "boldViolet",
  "yellow",
  "green",
  "gray",
] as const

type Sgr = { readonly [K in (typeof SGR_KEYS)[number]]: string }

/**
 * The style tokens (S41). Each one reads the style slots at call time, so
 * it is plain until the CLI runs `ui/setup.ts`.
 */
export const SGR: Sgr = {
  get reset() {
    return slots.codes.RESET
  },
  get bold() {
    return slots.codes.BOLD
  },
  get dim() {
    return slots.codes.DIM
  },
  get fgReset() {
    return slots.codes.FG_RESET
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
  get boldViolet() {
    return `${slots.codes.BOLD}${slots.palette.violet}`
  },
  get yellow() {
    return slots.palette.yellow
  },
  get green() {
    return slots.palette.green
  },
  get gray() {
    return slots.codes.BRIGHT_BLACK
  },
}

/** Wrap text in an SGR open + reset, with a guard for empty strings. */
export function wrap(text: string, sgr: string): string {
  if (text === "") return ""
  return `${sgr}${text}${SGR.reset}`
}

/** Wrap with dim. */
export function dim(text: string): string {
  return wrap(text, SGR.dim)
}

/** Strip SGR escapes — needed for visual-width math in tests. */
export function stripSgr(s: string): string {
  return stripAnsi(s)
}

/** Visible cell width for the mention menu's deliberately 1-cell glyph set. */
export function visualWidth(s: string): number {
  return stripSgr(s).length
}

/** Right-pad a possibly styled string to a visible width. */
export function padRight(s: string, width: number, padChar = " "): string {
  const w = visualWidth(s)
  if (w >= width) return s
  return s + padChar.repeat(width - w)
}

/** Truncate plain text to a visible width, appending an ellipsis when clipped. */
export function truncate(s: string, maxWidth: number): string {
  if (visualWidth(s) <= maxWidth) return s
  return s.slice(0, Math.max(0, maxWidth - 1)) + "…"
}

/**
 * Truncate an ANSI-bearing string to `maxCells` visible width, keeping SGR
 * sequences intact. Used as a final clamp so footer rows never wrap.
 */
export function truncateVisible(s: string, maxCells: number): string {
  if (maxCells <= 0) return ""
  let out = ""
  let cells = 0
  let i = 0
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      const end = s.indexOf("m", i)
      if (end < 0) break
      out += s.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (cells >= maxCells) break
    out += s[i]
    cells++
    i++
  }
  return out
}

/** Default SGR for resolved at-token buffer highlights. */
export function mentionTokenSgr(): string {
  return SGR.boldViolet
}
