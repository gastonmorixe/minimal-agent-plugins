/**
 * ANSI style helpers for the human-facing transcript chrome.
 *
 * Colors are drawn from the host-injected `MINIMAL_AGENT_PALETTE` env var
 * so plugin output stays theme-coherent with the agent. Falls back to
 * hardcoded ANSI codes when the env isn't set (standalone tests, legacy
 * agent builds).
 *
 * Pure string wrappers; no state. Model-facing `content` never carries ANSI.
 *
 * @module lib/style
 */

// ---------------------------------------------------------------------------
// Fallback hardcoded ANSI constants (used when MINIMAL_AGENT_PALETTE is absent)
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m"
const RESET_BOLD = "\x1b[22m"
const DIM = "\x1b[2m"
const RESET_DIM = "\x1b[22m"
const FG_RESET = "\x1b[39m"

// Legacy 4-bit fallbacks.
const FALLBACK: Record<string, string> = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m", // BRIGHT_BLACK — no "gray" in the host palette
}

// ---------------------------------------------------------------------------
// Parse the host-injected palette
// ---------------------------------------------------------------------------

/** token → SGR open sequence, or null when the env is missing. */
let palette: Record<string, string> | null = null

try {
  const raw = typeof process !== "undefined" ? process.env?.MINIMAL_AGENT_PALETTE : undefined
  if (raw) {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      palette = parsed as Record<string, string>
    }
  }
} catch {
  // malformed env → fall through to hardcoded
}

/** Resolve a foreground SGR open from the palette, falling back to hardcoded. */
function fgOpen(name: string): string {
  if (palette && name in palette) return palette[name]!
  return FALLBACK[name] ?? "\x1b[37m" // white as last resort
}

/** Resolve FG_RESET from the palette env, falling back to universal ANSI. */
const fgReset: string = palette?._fgReset ?? FG_RESET

// ---------------------------------------------------------------------------
// Public helpers (same signatures as before — no import changes in consumers)
// ---------------------------------------------------------------------------

/** Bold. Universal ANSI attribute, not theme-dependent. */
export function bold(s: string): string {
  return `${BOLD}${s}${RESET_BOLD}`
}

/** Dim. Universal ANSI attribute, not theme-dependent. */
export function dim(s: string): string {
  return `${DIM}${s}${RESET_DIM}`
}

/** Red foreground (theme-aware). */
export function red(s: string): string {
  return `${fgOpen("red")}${s}${fgReset}`
}

/** Green foreground (theme-aware). */
export function green(s: string): string {
  return `${fgOpen("green")}${s}${fgReset}`
}

/** Yellow foreground (theme-aware). */
export function yellow(s: string): string {
  return `${fgOpen("yellow")}${s}${fgReset}`
}

/** Cyan foreground (theme-aware). */
export function cyan(s: string): string {
  return `${fgOpen("cyan")}${s}${fgReset}`
}

/** Magenta foreground (theme-aware). */
export function magenta(s: string): string {
  return `${fgOpen("magenta")}${s}${fgReset}`
}

/** Gray foreground. Not in the host palette; falls back to BRIGHT_BLACK. */
export function gray(s: string): string {
  return `${fgOpen("gray")}${s}${fgReset}`
}

/** Dim cyan for frame connectors (`╭`, `│`, `╰`). */
const DIM_CYAN = "\x1b[2;36m"
const RESET_DIM_CYAN = "\x1b[22;39m"

/** Dim cyan formatted text. */
export function dimCyan(s: string): string {
  return `${DIM_CYAN}${s}${RESET_DIM_CYAN}`
}
