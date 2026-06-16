/**
 * Tiny ANSI helpers for the human-facing transcript chrome. Pure string
 * wrappers; no state. Model-facing `content` never carries ANSI.
 *
 * @module lib/style
 */

const BOLD = "\x1b[1m"
const RESET_BOLD = "\x1b[22m"
const DIM = "\x1b[2m"
const RESET_DIM = "\x1b[22m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const MAGENTA = "\x1b[35m"
const GRAY = "\x1b[90m"
const RESET_FG = "\x1b[39m"

/** Bold. */
export function bold(s: string): string {
  return `${BOLD}${s}${RESET_BOLD}`
}
/** Dim. */
export function dim(s: string): string {
  return `${DIM}${s}${RESET_DIM}`
}
/** Red foreground. */
export function red(s: string): string {
  return `${RED}${s}${RESET_FG}`
}
/** Green foreground. */
export function green(s: string): string {
  return `${GREEN}${s}${RESET_FG}`
}
/** Yellow foreground. */
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET_FG}`
}
/** Cyan foreground. */
export function cyan(s: string): string {
  return `${CYAN}${s}${RESET_FG}`
}
/** Magenta foreground. */
export function magenta(s: string): string {
  return `${MAGENTA}${s}${RESET_FG}`
}
/** Gray foreground. */
export function gray(s: string): string {
  return `${GRAY}${s}${RESET_FG}`
}
