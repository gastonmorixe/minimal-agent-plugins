/**
 * Pure overlay state machine for at-mention peer autocomplete.
 *
 * Functional core, imperative shell: this module is the *core*. No I/O, no
 * globals, no clocks. Handlers observe the editor, call `transition()`, and
 * apply the returned effects.
 *
 * Trigger: cursor sits in a token matching
 *   `/(^|[\s([{])@([A-Za-z0-9_-]*)$/`
 * against text up to the cursor (mid-line ok). Close when no active token, or Esc.
 *
 * Key behavior (mirrors slash-menu):
 *   - ArrowUp/Down: nav (halt)
 *   - Tab: complete to `@Name ` / `@short ` (trailing space, halt)
 *   - Enter: complete to `@Name` / `@short` WITHOUT halt so submit fires
 *   - Escape: close (halt)
 *
 */

import { LIVENESS_RANK } from "../liveness.ts"

import { fuzzyMatch, sortByScore } from "./fuzzy.ts"
import { renderOverlay } from "./render.ts"
import type { MentionOverlayState, PeerCandidate, ScoredPeer } from "./types.ts"

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Active at-token at the cursor: must be preceded by start-of-string or a
 * whitespace / open-bracket char, then `@` + optional identifier body.
 * Applied to `text.slice(0, cursor)`.
 */
const ACTIVE_TOKEN_RE = /(^|[\s([{])@([A-Za-z0-9_-]*)$/

export interface ActiveToken {
  /** Absolute index of the `@` in the full buffer. */
  readonly at: number
  /** Body after `@` (may be empty). */
  readonly query: string
  /** Exclusive end = cursor. */
  readonly end: number
}

/** Find the active at-mention token under the cursor, or null. */
export function findActiveToken(text: string, cursor: number): ActiveToken | null {
  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
  const m = ACTIVE_TOKEN_RE.exec(head)
  if (!m) return null
  const prefix = m[1] ?? ""
  const query = m[2] ?? ""
  // m.index is start of (prefix + @ + query). `@` sits after prefix.
  const at = m.index + prefix.length
  return { at, query, end: head.length }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type State =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open"
      readonly query: string
      readonly tokenStart: number
      readonly tokenEnd: number
      readonly selectedIndex: number
      readonly scrollOffset: number
    }

export const CLOSED: State = { kind: "closed" }

// ---------------------------------------------------------------------------
// Events / effects
// ---------------------------------------------------------------------------

export type Event =
  | { kind: "buffer-changed"; text: string; cursor: number }
  | { kind: "key"; name: KeyName }

export type KeyName = "Tab" | "Enter" | "Escape" | "ArrowUp" | "ArrowDown"

export type Effect =
  | { kind: "paint-footer"; lines: string[] }
  | { kind: "clear-footer" }
  | { kind: "set-buffer"; text: string; cursor?: number }
  | { kind: "halt-key" }
  | { kind: "set-styles"; spans: { start: number; end: number; style: string }[] }

export interface TransitionCtx {
  /** Peer candidates (already exclude-self). */
  peers: readonly PeerCandidate[]
  /** Terminal column width. */
  cols: number
  /** Max rows the menu may display. */
  maxRows?: number
  /**
   * Full buffer text (for completion rewrite). Required on key events that
   * complete; buffer-changed already carries text on the event.
   */
  bufferText?: string
}

export interface TransitionResult {
  state: State
  effects: Effect[]
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/** Apply one event to the mention FSM. Pure. */
export function transition(state: State, event: Event, ctx: TransitionCtx): TransitionResult {
  switch (event.kind) {
    case "buffer-changed":
      return onBufferChanged(state, event.text, event.cursor, ctx)
    case "key":
      return onKey(state, event.name, ctx)
  }
}

// ---------------------------------------------------------------------------
// buffer-changed
// ---------------------------------------------------------------------------

function onBufferChanged(
  state: State,
  text: string,
  cursor: number,
  ctx: TransitionCtx,
): TransitionResult {
  const token = findActiveToken(text, cursor)
  if (!token) {
    if (state.kind === "closed") return { state, effects: [] }
    return { state: CLOSED, effects: [{ kind: "clear-footer" }] }
  }

  const prevQuery = state.kind === "open" ? state.query : null
  const next: State = {
    kind: "open",
    query: token.query,
    tokenStart: token.at,
    tokenEnd: token.end,
    selectedIndex: state.kind === "open" && prevQuery === token.query ? state.selectedIndex : 0,
    scrollOffset: state.kind === "open" ? state.scrollOffset : 0,
  }

  return {
    state: next,
    effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }],
  }
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

function onKey(state: State, key: KeyName, ctx: TransitionCtx): TransitionResult {
  if (state.kind !== "open") return { state, effects: [] }

  const items = filteredPeers(state, ctx)
  if (items.length === 0) {
    if (key === "Escape") {
      return { state: CLOSED, effects: [{ kind: "clear-footer" }, { kind: "halt-key" }] }
    }
    return { state, effects: [] }
  }

  switch (key) {
    case "ArrowDown": {
      const idx = Math.min(items.length - 1, state.selectedIndex + 1)
      const next = { ...state, selectedIndex: idx }
      return {
        state: next,
        effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }, { kind: "halt-key" }],
      }
    }
    case "ArrowUp": {
      const idx = Math.max(0, state.selectedIndex - 1)
      const next = { ...state, selectedIndex: idx }
      return {
        state: next,
        effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }, { kind: "halt-key" }],
      }
    }
    case "Tab": {
      const selected = items[state.selectedIndex]
      if (!selected) return { state, effects: [{ kind: "halt-key" }] }
      const completed = completeIntoBuffer(ctx.bufferText ?? "", state, selected.slug, true)
      return {
        state,
        effects: [
          { kind: "set-buffer", text: completed.text, cursor: completed.cursor },
          { kind: "halt-key" },
        ],
      }
    }
    case "Enter": {
      const selected = items[state.selectedIndex]
      if (!selected) return { state, effects: [] }
      // Complete WITHOUT trailing space and WITHOUT halt so submit fires
      // with the completed @Name / @short.
      const completed = completeIntoBuffer(ctx.bufferText ?? "", state, selected.slug, false)
      return {
        state: CLOSED,
        effects: [
          { kind: "clear-footer" },
          { kind: "set-buffer", text: completed.text, cursor: completed.cursor },
        ],
      }
    }
    case "Escape": {
      return {
        state: CLOSED,
        effects: [{ kind: "clear-footer" }, { kind: "halt-key" }],
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Completion helper
// ---------------------------------------------------------------------------

/**
 * Replace the active `@query` span with `@slug` (+ optional trailing space).
 * Returns the new full buffer text and a cursor sitting after the insertion.
 */
export function completeIntoBuffer(
  text: string,
  state: Extract<State, { kind: "open" }>,
  slug: string,
  trailingSpace: boolean,
): { text: string; cursor: number } {
  const insert = `@${slug}${trailingSpace ? " " : ""}`
  const before = text.slice(0, state.tokenStart)
  const after = text.slice(state.tokenEnd)
  const next = before + insert + after
  return { text: next, cursor: before.length + insert.length }
}

// ---------------------------------------------------------------------------
// Scoring / filter
// ---------------------------------------------------------------------------

/** Prefer display name for completion slug; fall back to short sid. */
export function peerSlug(peer: PeerCandidate): string {
  const n = peer.name?.trim()
  return n && n.length > 0 ? n : peer.short
}

/**
 * Score one peer against a query. Matches against name, short, and full sid.
 * Returns the best score; slugMatches come from the slug surface (name/short).
 */
export function scorePeer(peer: PeerCandidate, query: string): ScoredPeer | null {
  const slug = peerSlug(peer)
  if (query === "") {
    return { ...peer, slug, score: 0, slugMatches: [] }
  }

  let bestScore = -1
  let slugMatches: number[] = []

  // Name / short (slug surface) — keep match indexes for highlight.
  const slugMatch = fuzzyMatch(slug, query)
  if (slugMatch.score >= 0) {
    bestScore = slugMatch.score
    slugMatches = slugMatch.matches
  }

  // Short sid (if different from slug).
  if (peer.short.toLowerCase() !== slug.toLowerCase()) {
    const m = fuzzyMatch(peer.short, query)
    if (m.score > bestScore) {
      bestScore = m.score
      // Matches aren't on the slug; don't highlight slug chars.
      slugMatches = []
    }
  }

  // Full sid.
  const sidMatch = fuzzyMatch(peer.sid, query)
  if (sidMatch.score > bestScore) {
    bestScore = sidMatch.score
    slugMatches = []
  }

  if (bestScore < 0) return null
  return { ...peer, slug, score: bestScore, slugMatches }
}

/** Filter + score + sort peers for the open menu. */
export function filteredPeers(
  state: Extract<State, { kind: "open" }>,
  ctx: TransitionCtx,
): ScoredPeer[] {
  const scored: ScoredPeer[] = []
  for (const peer of ctx.peers) {
    const s = scorePeer(peer, state.query)
    if (s) scored.push(s)
  }
  // Liveness rank first (online > stale > hung > dead > offline), then fuzzy score.
  scored.sort((a, b) => {
    const ra = LIVENESS_RANK[a.liveness.status]
    const rb = LIVENESS_RANK[b.liveness.status]
    if (ra !== rb) return ra - rb
    if (b.score !== a.score) return b.score - a.score
    return a.slug.localeCompare(b.slug)
  })
  return scored
}

/** Pure: state → paint lines. */
function paintLines(state: Extract<State, { kind: "open" }>, ctx: TransitionCtx): string[] {
  const items = filteredPeers(state, ctx)
  const overlayState: MentionOverlayState = {
    query: state.query,
    tokenStart: state.tokenStart,
    tokenEnd: state.tokenEnd,
    items,
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, items.length - 1)),
    scrollOffset: state.scrollOffset,
    maxRows: ctx.maxRows ?? 5,
    cols: ctx.cols,
  }
  return renderOverlay(overlayState)
}

// Re-export for tests that want sortByScore without going through fuzzy.
export { sortByScore }
