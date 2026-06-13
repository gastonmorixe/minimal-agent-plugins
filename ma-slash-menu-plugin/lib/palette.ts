/**
 * Slash-menu style facade.
 *
 * The host injects its palette as `MINIMAL_AGENT_PALETTE`; this module
 * consumes that shared context so the external plugin stays visually aligned
 * without importing from `minimal-agent/src/*`. The fallback palette keeps the
 * standalone preview and tests useful when the plugin is run outside the host.
 */

const FALLBACK_SGR = {
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

type Sgr = { readonly [K in keyof typeof FALLBACK_SGR]: string }

/** Resolve style tokens from the host-injected palette environment. */
export function resolveSgr(raw = process.env.MINIMAL_AGENT_PALETTE): Sgr {
  const palette = parsePaletteEnv(raw)
  const token = (name: string, fallback: string): string => palette?.[name] ?? fallback
  const dimToken = (name: string, fallback: string): string =>
    palette?.[name] ? `${FALLBACK_SGR.dim}${palette[name]}` : fallback
  const boldToken = (name: string, fallback: string): string =>
    palette?.[name] ? `${FALLBACK_SGR.bold}${palette[name]}` : fallback
  const reset = palette?._reset ?? FALLBACK_SGR.reset

  return {
    ...FALLBACK_SGR,
    reset,
    fgReset: palette?._fgReset ?? FALLBACK_SGR.fgReset,
    pink: token("pink", FALLBACK_SGR.pink),
    lime: token("lime", FALLBACK_SGR.lime),
    sky: token("sky", FALLBACK_SGR.sky),
    violet: token("violet", FALLBACK_SGR.violet),
    gold: token("gold", FALLBACK_SGR.gold),
    orange: token("orange", FALLBACK_SGR.orange),
    purple: token("purple", FALLBACK_SGR.purple),
    red: token("red", FALLBACK_SGR.red),
    brightRed: token("brightRed", FALLBACK_SGR.brightRed),
    white: token("white", FALLBACK_SGR.white),
    dimLime: dimToken("lime", FALLBACK_SGR.dimLime),
    dimSky: dimToken("sky", FALLBACK_SGR.dimSky),
    dimGold: dimToken("gold", FALLBACK_SGR.dimGold),
    dimRed: dimToken("red", FALLBACK_SGR.dimRed),
    boldSky: boldToken("sky", FALLBACK_SGR.boldSky),
    boldLime: boldToken("lime", FALLBACK_SGR.boldLime),
    boldRed: boldToken("brightRed", FALLBACK_SGR.boldRed),
    boldGold: boldToken("gold", FALLBACK_SGR.boldGold),
  }
}

function parsePaletteEnv(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return null
  }
}

export const SGR = resolveSgr()

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
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/** Visible cell width for the slash-menu's deliberately 1-cell glyph set. */
export function visualWidth(s: string): number {
  return stripSgr(s).length
}

/** Right-pad a possibly styled string to a visible width. */
export function padRight(s: string, width: number, padChar = " "): string {
  const w = visualWidth(s)
  if (w >= width) return s
  return s + padChar.repeat(width - w)
}

/** Left-pad a possibly styled string to a visible width. */
export function padLeft(s: string, width: number, padChar = " "): string {
  const w = visualWidth(s)
  if (w >= width) return s
  return padChar.repeat(width - w) + s
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
    if (s[i] === "\u001b") {
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
