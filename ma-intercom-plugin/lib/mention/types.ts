/**
 * Public types for the at-mention peer autocomplete overlay.
 *
 * Decoupled from the host plugin loader — pure data shapes the FSM, renderer,
 * rewrite, and style helpers share. Handlers translate host payloads into
 * these and apply the returned effects.
 *
 */

import type { Liveness } from "../liveness.ts"

/** One peer candidate the menu can complete / rewrite / style. */
export interface PeerCandidate {
  /** Full session uuid (address key). */
  readonly sid: string
  /** Short display handle (leading 8 chars). */
  readonly short: string
  /** Opt-in agent display name, e.g. "Michelle". Absent when naming is off. */
  readonly name?: string
  /** Agent process id. */
  readonly pid: number
  /** Resolved model id. */
  readonly model: string
  /** Working directory. */
  readonly cwd: string
  /** Derived liveness verdict (drives sort rank + status glyph color). */
  readonly liveness: Liveness
}

/**
 * One scored row in the mention menu.
 *
 * `slug` is what Tab/Enter complete to (name if present, else short sid).
 * Fuzzy matches may land on name, short, or full sid — `slugMatches` are
 * indexes into `slug` only (for highlight rendering).
 */
export interface ScoredPeer extends PeerCandidate {
  /** Bare completion token without the leading `@`. */
  readonly slug: string
  /** Composite fuzzy score (higher is better). Non-negative when kept. */
  readonly score: number
  /** Indexes into `slug` that matched the query (for bold-lime highlight). */
  readonly slugMatches: number[]
}

/** State the overlay renderer consumes. */
export interface MentionOverlayState {
  /** Buffer text after the active `@` (may be empty). */
  readonly query: string
  /** Absolute start index of the active `at-token` in the full buffer. */
  readonly tokenStart: number
  /** Absolute end index (cursor) of the active token. */
  readonly tokenEnd: number
  /** Items already filtered + scored, sorted best-first. */
  readonly items: readonly ScoredPeer[]
  /** Index into `items` of the currently selected row. */
  readonly selectedIndex: number
  /** Window's top row offset into `items`. */
  readonly scrollOffset: number
  /** Visible-row budget. Default 5. */
  readonly maxRows: number
  /** Terminal cols, drives truncation. */
  readonly cols: number
}

/**
 * A style span the host paints over the editor buffer.
 *
 * Core is wiring `editor.buffer.styles`; until then handlers emit on that
 * channel and pure code stays testable offline.
 */
export interface BufferStyleSpan {
  /** Inclusive start offset into the buffer text. */
  readonly start: number
  /** Exclusive end offset. */
  readonly end: number
  /** SGR open sequence (bold + color). Host applies + resets. */
  readonly style: string
}
