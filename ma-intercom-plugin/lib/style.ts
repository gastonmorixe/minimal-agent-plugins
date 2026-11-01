/**
 * Style helpers for the human-facing transcript chrome.
 *
 * Styles come from the style slots (S41). They are plain until the CLI runs
 * `ui/setup.ts`, which installs the CLI terminal kit, so plugin output stays
 * theme-coherent with the agent. Read at call time.
 *
 * Pure string wrappers; no state. Model-facing `content` never carries ANSI.
 *
 * @module lib/style
 */

import { slots } from "./style-slots.ts"

/** Bold. Universal attribute, not theme-dependent. */
export function bold(s: string): string {
  return slots.styles.bold(s)
}

/** Dim. Universal attribute, not theme-dependent. */
export function dim(s: string): string {
  return slots.styles.dim(s)
}

/** Red foreground (theme-aware). */
export function red(s: string): string {
  return slots.styles.red(s)
}

/** Green foreground (theme-aware). */
export function green(s: string): string {
  return slots.styles.green(s)
}

/** Yellow foreground (theme-aware). */
export function yellow(s: string): string {
  return slots.styles.yellow(s)
}

/** Cyan foreground (theme-aware). */
export function cyan(s: string): string {
  return slots.styles.cyan(s)
}

/** Magenta foreground (theme-aware). */
export function magenta(s: string): string {
  return slots.styles.magenta(s)
}

/** Gray foreground (BRIGHT_BLACK). */
export function gray(s: string): string {
  return slots.styles.gray(s)
}

/** Dim cyan for frame connectors (`╭`, `│`, `╰`). */
export function dimCyan(s: string): string {
  return slots.styles.dimCyan(s)
}
