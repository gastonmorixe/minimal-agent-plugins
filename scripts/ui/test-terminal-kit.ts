/**
 * A terminal kit for plugin tests (spec S41).
 *
 * The real kit lives in the CLI (`src/terminal-kit/kit.ts`). Plugin tests
 * that check styled display text install this kit into a plugin's style
 * slots. Its bytes match the CLI kit. It lives in a `ui/` folder because
 * it holds terminal escape codes.
 *
 * @module scripts/ui/test-terminal-kit
 */

import type {
  TerminalCodes,
  TerminalKit,
  TerminalPalette,
  TerminalStyles,
  TextStyle,
} from "@minimal-agent/core/plugin-api/utils/style-slots"

const PALETTE: TerminalPalette = {
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
  orange: "\x1b[38;5;208m",
  pink: "\x1b[38;5;199m",
  purple: "\x1b[38;5;98m",
  lime: "\x1b[38;5;118m",
  sky: "\x1b[38;5;45m",
  violet: "\x1b[38;2;180;140;255m",
  gold: "\x1b[38;5;214m",
}

const CODES: TerminalCodes = {
  RESET: "\x1b[0m",
  FG_RESET: "\x1b[39m",
  BG_RESET: "\x1b[49m",
  ERASE_LINE: "\x1b[2K",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  UNDERLINE: "\x1b[4m",
  INVERSE: "\x1b[7m",
  STRIKE: "\x1b[9m",
  BOLD_CLOSE: "\x1b[22m",
  DIM_CLOSE: "\x1b[22m",
  ITALIC_CLOSE: "\x1b[23m",
  UNDERLINE_CLOSE: "\x1b[24m",
  INVERSE_CLOSE: "\x1b[27m",
  STRIKE_CLOSE: "\x1b[29m",
  BRIGHT_BLACK: "\x1b[90m",
  DARK_GRAY: "\x1b[38;5;240m",
  LIGHT_GRAY: "\x1b[38;5;246m",
  FAINT_WHITE: "\x1b[2;37m",
  BOLD_WHITE: "\x1b[1;37m",
  BOLD_BRIGHT_RED: "\x1b[1;91m",
  DIM_LIME: "\x1b[2;38;5;118m",
  DIM_SKY: "\x1b[2;38;5;45m",
  DIM_GOLD: "\x1b[2;38;5;214m",
  DIM_RED: "\x1b[2;31m",
  DIM_VIOLET: "\x1b[2;38;2;180;140;255m",
  BOLD_SKY: "\x1b[1;38;5;45m",
  BOLD_LIME: "\x1b[1;38;5;118m",
  BOLD_GOLD: "\x1b[1;38;5;214m",
  BOLD_PINK: "\x1b[1;38;5;199m",
}

const wrap =
  (open: string, close: string): TextStyle =>
  (s) =>
    `${open}${s}${close}`
const fg = (open: string): TextStyle => wrap(open, CODES.FG_RESET)

const STYLES: TerminalStyles = {
  dim: wrap(CODES.DIM, CODES.DIM_CLOSE),
  cyan: fg(PALETTE.cyan),
  blue: fg(PALETTE.blue),
  magenta: fg(PALETTE.magenta),
  yellow: fg(PALETTE.yellow),
  green: fg(PALETTE.green),
  red: fg(PALETTE.red),
  white: fg(PALETTE.white),
  gray: fg(CODES.BRIGHT_BLACK),
  bold: wrap(CODES.BOLD, CODES.BOLD_CLOSE),
  italic: wrap(CODES.ITALIC, CODES.ITALIC_CLOSE),
  underline: wrap(CODES.UNDERLINE, CODES.UNDERLINE_CLOSE),
  inverse: wrap(CODES.INVERSE, CODES.INVERSE_CLOSE),
  brightCyan: fg(PALETTE.brightCyan),
  brightYellow: fg(PALETTE.brightYellow),
  brightGreen: fg(PALETTE.brightGreen),
  brightRed: fg(PALETTE.brightRed),
  brightMagenta: fg(PALETTE.brightMagenta),
  boldCyan: wrap("\x1b[1;36m", "\x1b[22;39m"),
  boldGreen: wrap("\x1b[1;32m", "\x1b[22;39m"),
  boldRed: wrap("\x1b[1;31m", "\x1b[22;39m"),
  boldYellow: wrap("\x1b[1;33m", "\x1b[22;39m"),
  boldWhite: wrap(CODES.BOLD_WHITE, CODES.RESET),
  boldBrightWhite: wrap("\x1b[1;97m", "\x1b[22;39m"),
  dimCyan: wrap("\x1b[2;36m", "\x1b[22;39m"),
  dimRed: wrap(CODES.DIM_RED, "\x1b[22;39m"),
  dimViolet: wrap(CODES.DIM_VIOLET, "\x1b[22;39m"),
  faintWhite: wrap(CODES.FAINT_WHITE, "\x1b[22;39m"),
  strike: wrap(CODES.STRIKE, CODES.STRIKE_CLOSE),
  orange: fg(PALETTE.orange),
  pink: fg(PALETTE.pink),
  purple: fg(PALETTE.purple),
  lime: fg(PALETTE.lime),
  sky: fg(PALETTE.sky),
  violet: fg(PALETTE.violet),
  gold: fg(PALETTE.gold),
  redPill: (s) => `\x1b[1;41;97m ${s} \x1b[0m`,
}

/** Color a unified diff like the CLI renderer (no palette env). */
function renderUnifiedDiff(patch: string, title?: string): string {
  const { BOLD, DIM, RESET } = CODES
  const out: string[] = []
  if (title) {
    out.push(`${BOLD}${title}${RESET}`)
    out.push(`${DIM}${"─".repeat(Math.min(title.length + 4, 64))}${RESET}`)
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) out.push(`${BOLD}${line}${RESET}`)
    else if (line.startsWith("@@")) out.push(`${PALETTE.cyan}${line}${RESET}`)
    else if (line.startsWith("+")) out.push(`${PALETTE.lime}${line}${RESET}`)
    else if (line.startsWith("-")) out.push(`${PALETTE.pink}${line}${RESET}`)
    else out.push(line)
  }
  return out.join("\n")
}

/** The test terminal kit. Same bytes as the CLI kit. */
export const TEST_TERMINAL_KIT: TerminalKit = {
  codes: CODES,
  styles: STYLES,
  palette: PALETTE,
  bgRgb: (r, g, b) => `\x1b[48;2;${r};${g};${b}m`,
  renderUnifiedDiff,
}
