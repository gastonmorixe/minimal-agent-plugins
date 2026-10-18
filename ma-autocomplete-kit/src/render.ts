/**
 * Overlay renderer.
 *
 * Pure function: takes {@link OverlayState} and returns the ANSI lines that
 * should be painted in the editor's footer band.
 *
 * Output is always exactly the requested number of rows so layout does not
 * jiggle.
 *
 * @module ma-autocomplete-kit/render
 */

import {
  dim,
  padLeft,
  padRight,
  SGR,
  truncate,
  truncateVisible,
  visualWidth,
  wrap,
} from "./palette.ts"
import { formatTokens, tokenSeverity } from "./tokens.ts"
import type { OverlayState, ScoredItem } from "./types.ts"

// ---------------------------------------------------------------------------
// Constants & layout heuristics
// ---------------------------------------------------------------------------

/** Indent under the prompt arrow (2 cells: matches editor content alignment). */
const INDENT = "  "
/**
 * Selection gutter glyph. `►` U+25BA BLACK RIGHT-POINTING POINTER is chosen
 * over `▶` U+25B6 because U+25B6 has `Emoji_Presentation=Yes` on many
 * terminals, which promotes it to a 2-cell color emoji and breaks the
 * 1-cell column layout (causes per-row overflow, wrap, live-area leakage).
 */
const ARROW = "►"
/** Slug column min/max width. */
const SLUG_MIN = 16
const SLUG_MAX = 30
/** Token column width (right-aligned). */
const TOKEN_COL_W = 6
/**
 * Category icon column (1 cell glyph + 1 cell gap = 2 cells reserved).
 * Both icons are deliberately 1-cell across every terminal we test.
 */
const ICON_ACTION = "◆"
const ICON_SKILL = "✦"
const ICON_PROMPT = "❯"
/** Reserved cells: 1 icon + 1 gap after. */
const ICON_COL_W = 2

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Maximum number of rows the overlay returns, including divider + hints.
 */
export function overlayHeight(state: OverlayState): number {
  const w = visibleWindow(state)
  const scrollRow = w.start > 0 ? 1 : 0
  return Math.max(1, w.count) + 2 + scrollRow
}

interface VisibleWindow {
  start: number
  end: number // exclusive
  count: number
}

/** Compute which slice of items.[start..end) we should render. */
function visibleWindow(state: OverlayState): VisibleWindow {
  const total = state.items.length
  if (total === 0) return { start: 0, end: 0, count: 0 }
  const maxRows = Math.max(1, state.maxRows)
  if (total <= maxRows) return { start: 0, end: total, count: total }

  // Keep the selection visible with 1-row context above/below when possible.
  let start = state.scrollOffset
  const sel = state.selectedIndex
  if (sel < start) start = sel
  if (sel >= start + maxRows) start = sel - maxRows + 1
  if (start < 0) start = 0
  if (start + maxRows > total) start = total - maxRows
  return { start, end: start + maxRows, count: maxRows }
}

// ---------------------------------------------------------------------------
// Per-row renderer
// ---------------------------------------------------------------------------

/** Render the slug with fuzzy-match highlighting. */
function renderSlug(slug: string, matches: number[], isSelected: boolean): string {
  const baseColor = isSelected ? SGR.boldSky : SGR.boldWhite
  if (matches.length === 0) return wrap(slug, baseColor)
  const matchSet = new Set(matches)
  let out = ""
  for (let i = 0; i < slug.length; i++) {
    const ch = slug[i]!
    if (matchSet.has(i)) {
      out += wrap(ch, SGR.boldLime)
    } else {
      out += wrap(ch, baseColor)
    }
  }
  return out
}

/** Pick the color for a token chip based on severity. */
function tokenChipColor(item: ScoredItem): string {
  const sev = tokenSeverity(item.tokens)
  switch (sev) {
    case "cheap":
      return SGR.dimLime
    case "normal":
      return SGR.faintWhite
    case "notable":
      return SGR.gold
    case "heavy":
      return SGR.dimRed
    case "very-heavy":
      return SGR.boldRed
    case "unknown":
      return SGR.dim
  }
}

/**
 * Pick the category-icon glyph + color for an item.
 *
 * Unknown categories degrade to a dim middle-dot: visible enough to say
 * "this row exists" without claiming an identity.
 */
function categoryIcon(category: string): { glyph: string; color: string } {
  switch (category) {
    case "act":
      return { glyph: ICON_ACTION, color: SGR.sky }
    case "skl":
      return { glyph: ICON_SKILL, color: SGR.violet }
    case "prm":
      return { glyph: ICON_PROMPT, color: SGR.lime }
    default:
      return { glyph: "·", color: SGR.dim }
  }
}

/** Render one item row at the given width, given the trigger sigil. */
function renderItemRow(
  item: ScoredItem,
  isSelected: boolean,
  trigger: string,
  cols: number,
): string {
  const sigilColor = trigger === "$" ? SGR.lime : SGR.pink
  const sigil = wrap(trigger, sigilColor)
  const arrow = isSelected ? wrap(ARROW, SGR.boldSky) : " "
  const slugW = clampSlugWidth(item.slug.length, cols)
  const slugRaw = renderSlug(item.slug, item.slugMatches, isSelected)
  const slugPadded = padRight(slugRaw, slugW)

  const tokenStr = formatTokens(item.tokens)
  const tokensCell =
    tokenStr === ""
      ? padRight("", TOKEN_COL_W)
      : padLeft(wrap(tokenStr, tokenChipColor(item)), TOKEN_COL_W)

  const { glyph: catGlyph, color: catColor } = categoryIcon(item.category)
  const iconCell = wrap(catGlyph, catColor)

  // Compose row pieces:
  //   [indent] [arrow] [space] [icon] [space] [sigil][slug-padded]
  //   [3-space gap] [description] [2-space gap] [tokens]
  const showDesc = cols >= 80
  const showTokens = cols >= 60
  const showIcon = cols >= 60

  let fixed = 2 + 1 + 1 + 1 + slugW
  if (showIcon) fixed += ICON_COL_W
  if (showDesc) fixed += 3
  if (showTokens) fixed += 2 + TOKEN_COL_W

  // Reserve 1 trailing cell so the last visible char never lands at cols-1
  // (some emulators auto-wrap when the cursor sits at col=cols).
  const safetyMargin = 1
  const descBudget = Math.max(4, cols - fixed - safetyMargin)

  const parts: string[] = [INDENT, arrow, " "]
  if (showIcon) parts.push(iconCell, " ")
  parts.push(sigil + slugPadded)

  if (showDesc) {
    let desc = truncate(item.description, descBudget)
    desc = item.disabled ? wrap(desc, SGR.dimRed) : dim(desc)
    parts.push("   ", padRight(desc, descBudget))
  } else {
    parts.push("  ")
  }

  if (showTokens) parts.push("  ", tokensCell)

  // Defense in depth: enforce visible width <= cols at render time so a
  // future arithmetic drift cannot leak a wrapping row to the user.
  const joined = parts.join("")
  if (visualWidth(joined) <= cols) return joined
  return truncateVisible(joined, cols)
}

function clampSlugWidth(slugLen: number, cols: number): number {
  const desired = Math.min(SLUG_MAX, Math.max(SLUG_MIN, slugLen))
  if (cols < 60) return Math.min(desired, 20)
  return desired
}

// ---------------------------------------------------------------------------
// Scroll affordances, divider, hint
// ---------------------------------------------------------------------------

function renderScrollAffordance(label: string): string {
  return INDENT + dim(label)
}

function renderDivider(state: OverlayState, w: VisibleWindow): string {
  const remaining = state.items.length - w.end
  const note = remaining > 0 ? `↓ ${remaining} more` : ""
  const noteWidth = note ? 2 + note.length : 0
  const safetyMargin = 1
  const dashes = Math.max(4, state.cols - INDENT.length - noteWidth - safetyMargin)
  let line = INDENT + dim("─".repeat(dashes))
  if (note) line += "  " + dim(note)
  if (visualWidth(line) > state.cols) return truncateVisible(line, state.cols)
  return line
}

function renderHint(state: OverlayState): string {
  const selected = state.items[state.selectedIndex]
  const trigger = state.trigger
  const tabHint =
    selected !== undefined && state.query !== "" && !selected.disabled
      ? `${SGR.faintWhite}⇥ ${trigger}${selected.slug}${SGR.reset}`
      : `${SGR.faintWhite}⇥ complete${SGR.reset}`

  const enterHint = `${SGR.faintWhite}⏎ ${enterVerbFor(state)}${SGR.reset}`
  const chips = [`${SGR.faintWhite}↑↓ nav${SGR.reset}`, tabHint, enterHint]
  if (state.bodyVerb) {
    chips.push(`${SGR.faintWhite}⌥⏎ ${state.bodyVerb}${SGR.reset}`)
  }
  chips.push(`${SGR.faintWhite}esc close${SGR.reset}`)
  const sep = `${SGR.dim} · ${SGR.reset}`

  let line = INDENT + chips.join(sep)
  if (state.footerNote) {
    line += sep + wrap(state.footerNote, SGR.dimGold)
  }
  if (selected?.tokens !== undefined && state.contextWindow) {
    const cost = `${SGR.faintWhite}cost: ${formatTokens(selected.tokens)} of ${formatTokens(state.contextWindow)} ctx${SGR.reset}`
    line += sep + cost
  }
  // Never let the hint row wrap. Clip on the right so the most important
  // hints survive.
  if (visualWidth(line) > state.cols) return truncateVisible(line, state.cols)
  return line
}

function enterVerbFor(state: OverlayState): string {
  const item = state.items[state.selectedIndex]
  if (!item) return "—"
  if (item.disabled) return "(broken)"
  return state.enterVerb ?? "insert"
}
// ---------------------------------------------------------------------------
// Empty-state / no-match rendering
// ---------------------------------------------------------------------------

function renderEmpty(state: OverlayState): string[] {
  const query = state.query
  const message =
    query === "" ? "(nothing available)" : `no matches  ·  ${state.trigger}${query}`
  return [
    INDENT + dim(message),
    renderDivider(state, { start: 0, end: 0, count: 0 }),
    INDENT + `${SGR.faintWhite}esc to dismiss · backspace to refine${SGR.reset}`,
  ]
}

// ---------------------------------------------------------------------------
// Public render entry point
// ---------------------------------------------------------------------------

/**
 * Render the overlay into an array of ANSI lines.
 *
 * The caller paints these into the editor's footer band. Lines do NOT
 * include trailing `\n`.
 */
export function renderOverlay(state: OverlayState): string[] {
  if (state.items.length === 0) return renderEmpty(state)

  const w = visibleWindow(state)
  const lines: string[] = []
  if (w.start > 0) lines.push(renderScrollAffordance(`↑ ${w.start} more`))

  for (let i = w.start; i < w.end; i++) {
    const isSelected = i === state.selectedIndex
    lines.push(renderItemRow(state.items[i]!, isSelected, state.trigger, state.cols))
  }

  lines.push(renderDivider(state, w))
  lines.push(renderHint(state))
  return lines
}

// ---------------------------------------------------------------------------
// Test exports (named separately so dead-code linters can see them)
// ---------------------------------------------------------------------------

export const _internals = {
  visibleWindow,
  renderItemRow,
  renderDivider,
  renderHint,
  visualWidth,
  enterVerbFor,
}
