/**
 * Pure ANSI renderer for the at-mention peer autocomplete footer overlay.
 *
 * Row shape:
 *   ► ● Michelle online a1b2c3d4 pid 12345 grok-4.5 minimal-agent-monorepo
 *     ○ Ronald idle b2c3d4e5 pid 23456 ...
 *
 * Status glyphs:
 *   - Online/busy: green ●
 *   - Idle online: dim lime ○
 *   - Stale/hung: yellow ●
 *   - Dead/offline: red/gray ○
 *
 * Fuzzy match chars in the slug: bold lime. Selected row: bold sky arrow.
 *
 */

import { type Liveness, livenessLabel } from "../liveness.ts"
import { baseName } from "../render.ts"

import { dim, padRight, SGR, truncate, truncateVisible, visualWidth, wrap } from "./palette.ts"
import type { MentionOverlayState, ScoredPeer } from "./types.ts"

/** Indent under the prompt arrow (2 cells). */
const INDENT = "  "
/**
 * Selection gutter glyph — U+25BA (not U+25B6) so terminals don't promote it
 * to a 2-cell emoji (same caveat as slash-menu).
 */
const ARROW = "►"
const DOT_FILLED = "●"
const DOT_EMPTY = "○"

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Render the overlay into ANSI lines (no trailing newlines). */
export function renderOverlay(state: MentionOverlayState): string[] {
  if (state.items.length === 0) return renderEmpty(state)

  const w = visibleWindow(state)
  const lines: string[] = []
  if (w.start > 0) lines.push(INDENT + dim(`↑ ${w.start} more`))

  for (let i = w.start; i < w.end; i++) {
    const isSelected = i === state.selectedIndex
    lines.push(renderItemRow(state.items[i]!, isSelected, state.cols))
  }

  lines.push(renderDivider(state, w))
  lines.push(renderHint(state))
  return lines
}

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

interface VisibleWindow {
  start: number
  end: number
  count: number
}

function visibleWindow(state: MentionOverlayState): VisibleWindow {
  const total = state.items.length
  if (total === 0) return { start: 0, end: 0, count: 0 }
  const maxRows = Math.max(1, state.maxRows)
  if (total <= maxRows) return { start: 0, end: total, count: total }

  let start = state.scrollOffset
  const sel = state.selectedIndex
  if (sel < start) start = sel
  if (sel >= start + maxRows) start = sel - maxRows + 1
  if (start < 0) start = 0
  if (start + maxRows > total) start = total - maxRows
  return { start, end: start + maxRows, count: maxRows }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function statusGlyph(l: Liveness): { glyph: string; color: string } {
  switch (l.status) {
    case "online":
      if (l.phase === "busy") return { glyph: DOT_FILLED, color: SGR.green }
      if (l.phase === "idle") return { glyph: DOT_EMPTY, color: SGR.dimLime }
      return { glyph: DOT_FILLED, color: SGR.green }
    case "stale":
      return { glyph: DOT_FILLED, color: SGR.gold }
    case "hung":
      return { glyph: DOT_FILLED, color: SGR.yellow }
    case "dead":
      return { glyph: DOT_EMPTY, color: SGR.red }
    case "offline":
      return { glyph: DOT_EMPTY, color: SGR.gray }
    default: {
      const _e: never = l
      return { glyph: DOT_EMPTY, color: SGR.dim }
    }
  }
}

function renderSlug(slug: string, matches: number[], isSelected: boolean): string {
  const baseColor = isSelected ? SGR.boldSky : SGR.boldWhite
  if (matches.length === 0) return wrap(slug, baseColor)
  const matchSet = new Set(matches)
  let out = ""
  for (let i = 0; i < slug.length; i++) {
    const ch = slug[i]!
    if (matchSet.has(i)) out += wrap(ch, SGR.boldLime)
    else out += wrap(ch, baseColor)
  }
  return out
}

function renderItemRow(item: ScoredPeer, isSelected: boolean, cols: number): string {
  const arrow = isSelected ? wrap(ARROW, SGR.boldSky) : " "
  const { glyph, color } = statusGlyph(item.liveness)
  const statusDot = wrap(glyph, color)
  const slug = renderSlug(item.slug, item.slugMatches, isSelected)
  const verdict = livenessLabel(item.liveness)
  const short = item.short
  const pid = item.pid > 0 ? `pid ${item.pid}` : ""
  const model = item.model || ""
  const where = baseName(item.cwd)

  // Fixed prefix: INDENT(2) + arrow(1) + " "(1) + dot(1) + " "(1) + slug + " "(1)
  // Description: status · short · pid · model · cwd (dim)
  const descParts = [verdict, short]
  if (pid) descParts.push(pid)
  if (model) descParts.push(model)
  if (where) descParts.push(where)
  const desc = descParts.join(" · ")

  const slugW = Math.min(24, Math.max(8, item.slug.length))
  const slugPadded = padRight(slug, slugW)

  const fixed = 2 + 1 + 1 + 1 + 1 + slugW + 1
  const safetyMargin = 1
  const descBudget = Math.max(4, cols - fixed - safetyMargin)

  const parts = [
    INDENT,
    arrow,
    " ",
    statusDot,
    " ",
    slugPadded,
    " ",
    padRight(dim(truncate(desc, descBudget)), descBudget),
  ]
  const joined = parts.join("")
  if (visualWidth(joined) <= cols) return joined
  return truncateVisible(joined, cols)
}

// ---------------------------------------------------------------------------
// Divider / hint / empty
// ---------------------------------------------------------------------------

function renderDivider(state: MentionOverlayState, w: VisibleWindow): string {
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

function renderHint(state: MentionOverlayState): string {
  const selected = state.items[state.selectedIndex]
  const tabHint =
    selected !== undefined && state.query !== ""
      ? `${SGR.faintWhite}⇥ @${selected.slug}${SGR.reset}`
      : `${SGR.faintWhite}⇥ complete${SGR.reset}`
  const enterHint = `${SGR.faintWhite}⏎ mention + send${SGR.reset}`
  const chips = [
    `${SGR.faintWhite}↑↓ nav${SGR.reset}`,
    tabHint,
    enterHint,
    `${SGR.faintWhite}esc close${SGR.reset}`,
  ]
  const sep = `${SGR.dim} · ${SGR.reset}`
  let line = INDENT + chips.join(sep)
  if (visualWidth(line) > state.cols) return truncateVisible(line, state.cols)
  return line
}

function renderEmpty(state: MentionOverlayState): string[] {
  const q = state.query
  const message = q === "" ? "(no peers online)" : `no peers match  ·  @${q}`
  return [
    INDENT + dim(message),
    renderDivider(state, { start: 0, end: 0, count: 0 }),
    INDENT + `${SGR.faintWhite}esc to dismiss · backspace to refine${SGR.reset}`,
  ]
}

export const _internals = {
  visibleWindow,
  renderItemRow,
  statusGlyph,
  visualWidth,
}
