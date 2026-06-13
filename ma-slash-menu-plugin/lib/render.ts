/**
 * Overlay renderer.
 *
 * Pure function: takes {@link OverlayState} + a precomputed selection
 * window, returns the ANSI lines that should be painted ABOVE the
 * editor in the live area's decoration slot.
 *
 * Output is always exactly the requested number of rows (caller pads /
 * truncates so layout doesn't jiggle).
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
import type { OverlayState, ScoredItem, Trigger } from "./types.ts"

// ---------------------------------------------------------------------------
// Constants & layout heuristics
// ---------------------------------------------------------------------------

/** Indent under the prompt arrow (2 cells: matches editor's content alignment). */
const INDENT = "  "
/**
 * Selection gutter glyph for the current row.
 *
 * `►` U+25BA BLACK RIGHT-POINTING POINTER — chosen over `▶` U+25B6
 * because U+25B6 has `Emoji_Presentation=Yes` on many terminals (iTerm,
 * Kitty), which promotes it to a 2-cell color emoji and breaks the
 * 1-cell column layout (causes per-row overflow → wrap → live-area
 * leakage on every keypress, see commit history May 2026).
 *
 * U+25BA is the same Geometric-Shapes family, visually similar bold
 * silhouette, and reliably 1 cell across every terminal we test.
 */
const ARROW = "►"
/** Slug column min/max width. */
const SLUG_MIN = 16
const SLUG_MAX = 30
/** Token column width (right-aligned). */
const TOKEN_COL_W = 6
/**
 * Category icon column (1 cell glyph + 1 cell gap = 2 cells reserved).
 *
 * Pre-2026-05 the row carried a trailing 3-cell text badge (`act` /
 * `skl`). The badge was width-stable but cryptic — users had to learn
 * vocabulary. We swapped to a leading single-char icon that signals
 * category via shape + color, no reading required.
 *
 * Both icons are deliberately chosen for **1-cell width across every
 * terminal we test**:
 *
 *   - `◆` U+25C6 BLACK DIAMOND — `Emoji_Presentation=No`. Reserved for
 *     "action" items (commands the host handles directly, no LLM cost).
 *     Rendered in sky/cyan.
 *   - `✦` U+2726 BLACK FOUR POINTED STAR — `Emoji_Presentation=No`.
 *     Reserved for "skill" items (loaded into the model's context).
 *     Rendered in violet, matching the agent's startup-tree convention
 *     where `✦ Skill` already names the Skill tool family.
 *
 * Other glyphs we considered and rejected:
 *
 *   - `⚡` U+26A1 HIGH VOLTAGE — `Emoji_Presentation=Yes`. iTerm/Kitty
 *     promote it to a 2-cell color emoji; would re-introduce the wrap
 *     bug fixed in commit history May 2026.
 *   - `⚙` U+2699 GEAR — same emoji-presentation risk on some platforms.
 *   - `▶` U+25B6 — emoji upgrade risk (same family as the ARROW caveat
 *     above).
 */
const ICON_ACTION = "◆"
const ICON_SKILL = "✦"
/** Reserved cells: 1 icon + 1 gap after. */
const ICON_COL_W = 2

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Maximum number of rows the overlay returns, including divider + hints.
 * Caller can use this to reserve vertical space.
 */
export function overlayHeight(state: OverlayState): number {
  // Rows shown + 1 divider + 1 hint line, plus a `↑ N more` affordance row
  // when the window is scrolled down (renderOverlay emits it iff start > 0).
  // Must match renderOverlay's row count exactly or the caller under-reserves
  // vertical space and the live area wraps.
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

/**
 * Render the slug with fuzzy-match highlighting.
 *
 * The slug is the primary identifier of each row — the thing the user
 * is actually reading and choosing between. It earns **bold white** on
 * unselected rows (visible, not shouting) and **bold sky** on the
 * selected row (selection emphasis). Fuzzy-matched characters take
 * **bold lime** to pop against either background, signalling where the
 * query landed.
 *
 * Pre-2026-05 the unselected slug was `faintWhite` (dim grey) which
 * sank under the dim description text and made the menu hard to scan
 * at a glance. The user called this out and was right.
 */
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

/** Pick the color for a token chip based on severity + selection state. */
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
 * Unknown categories degrade to a dim middle-dot — visible enough to
 * say "this row exists" without claiming an identity.
 */
function categoryIcon(category: string): { glyph: string; color: string } {
  switch (category) {
    case "act":
      return { glyph: ICON_ACTION, color: SGR.sky }
    case "skl":
      return { glyph: ICON_SKILL, color: SGR.violet }
    default:
      return { glyph: "·", color: SGR.dim }
  }
}

/** Render one item row at the given width, given trigger sigil. */
function renderItemRow(
  item: ScoredItem,
  isSelected: boolean,
  trigger: Trigger,
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
  //
  // The trailing 3-letter text badge from earlier iterations is gone —
  // category is conveyed by the leading icon + color (◆ sky for action,
  // ✦ violet for skill). Saves 5 cells of horizontal real estate that
  // the description gets to use instead.
  const showDesc = cols >= 80
  const showTokens = cols >= 60
  const showIcon = cols >= 60

  // Fixed width = everything EXCEPT desc. Walk the layout once:
  //   INDENT(2) + arrow(1) + " "(1) + (if icon: ICON_COL_W(2))
  //     + sigil(1) + slug(slugW)
  //     + (if desc: "   "(3) + descBudget)
  //     + (if tokens: "  "(2) + TOKEN_COL_W(6))
  let fixed = 2 + 1 + 1 + 1 + slugW
  if (showIcon) fixed += ICON_COL_W
  if (showDesc) fixed += 3
  if (showTokens) fixed += 2 + TOKEN_COL_W

  // Reserve 1 trailing cell so the last visible char never lands at
  // cols-1 (some emulators auto-wrap when the cursor sits at col=cols
  // even if the glyph fits — defense in depth).
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

  // Defense in depth: enforce visible width <= cols at render time so
  // a future arithmetic drift cannot leak a wrapping row to the user.
  // Truncates with no marker — better a clean clip than a wrap.
  const joined = parts.join("")
  if (visualWidth(joined) <= cols) return joined
  return truncateVisible(joined, cols)
}

function clampSlugWidth(slugLen: number, cols: number): number {
  // Slug col grows up to a point to accommodate long skill names like
  // `swift-concurrency-expert` (23 chars) without truncation, then caps.
  const desired = Math.min(SLUG_MAX, Math.max(SLUG_MIN, slugLen))
  if (cols < 60) return Math.min(desired, 20)
  return desired
}

// ---------------------------------------------------------------------------
// Top-of-list / bottom-of-list scroll affordances
// ---------------------------------------------------------------------------

function renderScrollAffordance(label: string): string {
  return INDENT + dim(label)
}

// ---------------------------------------------------------------------------
// Divider + footer hint line
// ---------------------------------------------------------------------------

function renderDivider(state: OverlayState, w: VisibleWindow): string {
  const remaining = state.items.length - w.end
  const note = remaining > 0 ? `↓ ${remaining} more` : ""
  // Width budget: cols - INDENT(2) - (note ? "  "(2) + note.length : 0) - 1
  // (1-cell trailing safety margin, same rationale as renderItemRow).
  const noteWidth = note ? 2 + note.length : 0
  const safetyMargin = 1
  const dashes = Math.max(4, state.cols - INDENT.length - noteWidth - safetyMargin)
  let line = INDENT + dim("─".repeat(dashes))
  if (note) line += "  " + dim(note)
  // Defense: clamp final visible width to cols just in case.
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

  const enterVerb = enterVerbFor(state)
  const enterHint = `${SGR.faintWhite}⏎ ${enterVerb}${SGR.reset}`

  const chips = [
    `${SGR.faintWhite}↑↓ nav${SGR.reset}`,
    tabHint,
    enterHint,
    `${SGR.faintWhite}esc close${SGR.reset}`,
  ]
  const sep = `${SGR.dim} · ${SGR.reset}`

  let line = INDENT + chips.join(sep)
  if (trigger === "$") {
    line += sep + wrap("forced activation", SGR.dimGold)
  }
  // Cost-vs-context chip when forced + selected has tokens + ctx known.
  if (trigger === "$" && selected?.tokens !== undefined && state.contextWindow) {
    const cost = `${SGR.faintWhite}cost: ${formatTokens(selected.tokens)} of ${formatTokens(state.contextWindow)} ctx${SGR.reset}`
    line += sep + cost
  }
  // Defense: never let the hint row wrap. If the chips collectively
  // exceed the terminal width, clip on the right — the user sees the
  // most-important hints first (nav/complete/select), the optional
  // suffixes drop off.
  if (visualWidth(line) > state.cols) return truncateVisible(line, state.cols)
  return line
}

function enterVerbFor(state: OverlayState): string {
  const item = state.items[state.selectedIndex]
  if (!item) return "—"
  if (item.disabled) return "(broken)"
  if (state.trigger === "$") return "activate skill"
  return item.category === "skl" ? "load skill" : "run"
}

// ---------------------------------------------------------------------------
// Empty-state / no-match rendering
// ---------------------------------------------------------------------------

function renderEmpty(state: OverlayState): string[] {
  const query = state.query
  const message =
    query === "" ? "(no commands available)" : `no commands match  ·  ${state.trigger}${query}`
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
 * The caller paints these into the editor's decoration slot. Lines do
 * NOT include trailing `\n` — the live-area system joins with `\n`.
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
