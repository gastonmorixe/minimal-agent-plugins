/**
 * Local SGR shortcuts.
 *
 * Mirrors the colors in minimal-agent's `src/palette.ts` so the plugin
 * renders in the same visual family. Kept as raw byte strings to stay
 * dependency-light — the plugin should be installable standalone
 * without importing into the host repo's source tree.
 */

export const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strike: "\x1b[9m",
  fgReset: "\x1b[39m",
  bgReset: "\x1b[49m",
  // Modern "Cool Summer" palette (synced with src/palette.ts).
  pink: "\x1b[38;5;199m",
  lime: "\x1b[38;5;118m",
  sky: "\x1b[38;5;45m",
  violet: "\x1b[38;2;180;140;255m",
  gold: "\x1b[38;5;214m",
  orange: "\x1b[38;5;208m",
  purple: "\x1b[38;5;98m",
  // Standard.
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  white: "\x1b[37m",
  faintWhite: "\x1b[2;37m",
  boldWhite: "\x1b[1;37m",
  // For headers / dim labels.
  dimLime: "\x1b[2;38;5;118m",
  dimSky: "\x1b[2;38;5;45m",
  dimGold: "\x1b[2;38;5;214m",
  dimRed: "\x1b[2;31m",
  boldSky: "\x1b[1;38;5;45m",
  boldLime: "\x1b[1;38;5;118m",
  boldRed: "\x1b[1;91m",
  boldGold: "\x1b[1;38;5;214m",
} as const

/** Wrap text in an SGR open + reset, with a guard for empty strings. */
export function wrap(text: string, sgr: string): string {
  if (text === "") return ""
  return `${sgr}${text}${SGR.reset}`
}

/** Wrap with dim. */
export function dim(text: string): string {
  return wrap(text, SGR.dim)
}

/** Wrap with the configured "selected row" emphasis. */
export function selected(text: string): string {
  return wrap(text, SGR.boldSky)
}

/** Strip SGR escapes — needed for visual-width math in tests. */
export function stripSgr(s: string): string {
  // ESC = U+001B; intentional control char to match real ANSI streams.
  return s.replace(/\u001b\[[\d;]*m/g, "")
}
