/**
 * Shared glyphs + palette for the sub-agents TUI (scrollback blocks and the
 * live fleet widget). Pure monochrome unicode (no nerd-font, no color-emoji),
 * matching the `tasks` plugin so a worker and a task read as one visual
 * language. See `private/subagent-research-and-plan/TUI.md`.
 *
 * @module sub-agents/lib/style
 */

import { slots } from "./style-slots.ts"
import type { SubagentStatus } from "./types.ts"

/** Wrap text in style codes and a full reset when `ansi` is true (S41 style slots). */
export const color = slots.color

/** Glyphs. Status glyphs are intentionally shared with the `tasks` plugin. */
export const GLYPHS = {
  brand: "◈", // U+25C8 sub-agents identity (distinct from tasks' ○)
  queued: "○", // U+25CB
  running: "◐", // U+25D0  (the widget cycles ◐◓◑◒ for a pulse)
  done: "✔", // U+2714
  incomplete: "⚠", // U+26A0  clean exit but no deliverable captured
  failed: "✘", // U+2718
  spawn: "↗", // U+2197  delegation arrow
  report: "↘", // U+2198  result-came-back arrow
  frameTL: "╭",
  frameML: "│",
  frameBL: "╰",
  bullet: "·",
  dotOn: "●", // U+25CF  live widget: a running row, blink frame "on"
  dotOff: "○", // U+25CB  live widget: a running row, blink frame "off"
  dotQueued: "◌", // U+25CC  live widget: a queued row
  treeMid: "├", // live widget: a tree row that is not the last
  treeLast: "╰", // live widget: the last tree row
  unknown: "—", // live widget: no model is known
} as const

/** Frames of the old running spinner. The live widget does not use them now. */
export const SPINNER = ["◐", "◓", "◑", "◒"] as const

export const ANSI = {
  get RESET() {
    return slots.codes.RESET
  },
  get BOLD() {
    return slots.codes.BOLD
  },
  get DIM() {
    return slots.codes.DIM
  },
  get ITALIC() {
    return slots.codes.ITALIC
  },
  get LIME() {
    return slots.palette.lime
  }, // done
  get SKY() {
    return slots.palette.sky
  }, // running
  get RED() {
    return slots.palette.red
  }, // failed
  get GOLD() {
    return slots.palette.gold
  }, // spawn / cost-over-budget
  get DGRAY() {
    return slots.codes.DARK_GRAY
  }, // frame chrome
  get LGRAY() {
    return slots.codes.LIGHT_GRAY
  }, // secondary chrome
} as const

/** The status glyph for a worker, colored by state. */
export function statusGlyph(s: SubagentStatus, ansi: boolean): string {
  switch (s.kind) {
    case "queued":
      return slots.color(ansi, ANSI.DIM, GLYPHS.queued)
    case "running":
      return slots.color(ansi, ANSI.SKY, GLYPHS.running)
    case "done":
      return slots.color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)
    case "incomplete":
      return slots.color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, GLYPHS.incomplete)
    case "failed":
      return slots.color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)
    case "stopped":
      return slots.color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
}

/** A one-word status label colored by state (for headers/rows). */
export function statusLabel(s: SubagentStatus, ansi: boolean): string {
  switch (s.kind) {
    case "queued":
      return slots.color(ansi, ANSI.DIM, "queued")
    case "running":
      return slots.color(ansi, ANSI.SKY, "running")
    case "done":
      return slots.color(ansi, ANSI.LIME, "done")
    case "incomplete":
      return slots.color(ansi, ANSI.GOLD, "incomplete")
    case "failed":
      return slots.color(ansi, ANSI.RED, "failed")
    case "stopped":
      return slots.color(ansi, ANSI.RED, "stopped")
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
}

/** Format a token count compactly: 950 → "950", 9100 → "9.1k", 612000 → "612k". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * One worker's (or the fleet's) token figures. `tokens` is last-turn context
 * (for the fleet: the sum of the last-turn context of each worker).
 * `output` and `thinking` are summed generated tokens.
 */
export interface SpendCounts {
  readonly tokens: number
  readonly output?: number
  readonly thinking?: number
}

/** The ` · out 2.8k (thinking 61)` tail, or `""` when no output is known. */
function outTail(c: SpendCounts): string {
  if (!c.output) return ""
  const thinking = c.thinking ? ` (thinking ${fmtTokens(c.thinking)})` : ""
  return ` · out ${fmtTokens(c.output)}${thinking}`
}

/**
 * Format the token figures of ONE worker: `"ctx 61.3k · out 2.8k (thinking 61)"`.
 * When no output is known (an old record, or a provider that reports none,
 * such as Cursor), fall back to the old single figure `"61.3k tok"`.
 */
export function fmtSpend(c: SpendCounts): string {
  if (!c.output) return `${fmtTokens(c.tokens)} tok`
  return `ctx ${fmtTokens(c.tokens)}${outTail(c)}`
}

/**
 * Format the token figures of the FLEET (a `fleetStats` value):
 * `"Σctx 101k · out 3.3k (thinking 70)"`. `Σctx` is the sum of the last-turn
 * context of each worker. It is not one context window, and not a billed
 * total. With no output known, it gives `"Σctx 101k"`, so the sum always has
 * its label.
 */
export function fmtFleetSpend(c: SpendCounts): string {
  return `Σctx ${fmtTokens(c.tokens)}${outTail(c)}`
}

/** Format an elapsed-ms duration: "0m31", "1m22", "1h04". Empty under 1s. */
export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, "0")}`
}
