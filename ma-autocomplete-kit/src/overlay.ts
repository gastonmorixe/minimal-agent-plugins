/**
 * Pure overlay state machine for the autocomplete kit.
 *
 * # Design
 *
 * **Functional core, imperative shell**: this module is the *core*.
 * No I/O, no globals, no clocks. A plugin's handlers are the *shell*: they
 * observe the editor, call `transition()`, and apply the returned effects.
 *
 * **Sigil-agnostic**: every branch reads the active {@link TriggerSpec}
 * instead of a hardcoded character class. The same FSM drives `$`, `&`, `@`,
 * or any future sigil.
 *
 * **Reducer signature**: `transition(state, event, ctx) -> {state, effects}`.
 * Pure; for the same inputs the output is always identical.
 *
 * @module ma-autocomplete-kit/overlay
 */

import { renderOverlay } from "./render.ts"
import { applySortMode, filterByCategories, scoreItems } from "./scoring.ts"
import type { Item, OverlayState, ScoredItem, TriggerSpec } from "./types.ts"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type State =
  | { readonly kind: "closed" }
  | { readonly kind: "armed"; readonly sigil: string; readonly tokenStart: number }
  | {
      readonly kind: "open"
      readonly sigil: string
      readonly query: string
      readonly tokenStart: number
      readonly tokenEnd: number
      readonly selectedIndex: number
      readonly scrollOffset: number
    }

export const CLOSED: State = { kind: "closed" }

// ---------------------------------------------------------------------------
// Events (driven by the imperative shell)
// ---------------------------------------------------------------------------

export type Event =
  | { kind: "sigil-typed"; sigil: string; cursor: number }
  | { kind: "buffer-changed"; text: string; cursor?: number }
  | { kind: "key"; name: KeyName }

/**
 * `Alt+Enter` inserts the item's body (the "bigger Enter"). `Enter` inserts
 * the bare name. `Tab` completes the name in place.
 */
export type KeyName = "Tab" | "Enter" | "Alt+Enter" | "Escape" | "ArrowUp" | "ArrowDown"

// ---------------------------------------------------------------------------
// Effects (applied by the shell)
// ---------------------------------------------------------------------------

/**
 * Side-effects the shell should perform. `paint-footer` is the only thing
 * the renderer needs the host to do on every state change; the other effects
 * fire in response to specific keys.
 */
export type Effect =
  | { kind: "paint-footer"; lines: string[] }
  | { kind: "clear-footer" }
  | { kind: "set-buffer"; text: string; cursor?: number }
  | { kind: "halt-key" }

// ---------------------------------------------------------------------------
// Reducer context (what the shell knows that the core needs)
// ---------------------------------------------------------------------------

export interface TransitionCtx {
  /** The active namespace description. */
  spec: TriggerSpec
  /** All available items from every provider. */
  allItems: readonly Item[]
  /** Terminal column width. Drives render's degradation ladder. */
  cols: number
  /** Active model's context window in tokens, for the cost chip. */
  contextWindow?: number
  /** Max rows the menu may display. Default 5. */
  maxRows?: number
  /** Full editor buffer, used to preserve surrounding text on completion. */
  bufferText?: string
}

// ---------------------------------------------------------------------------
// Core transitions
// ---------------------------------------------------------------------------

export interface TransitionResult {
  state: State
  effects: Effect[]
}

/**
 * Apply one event to the FSM. Returns the new state plus any effects the
 * shell should run.
 *
 * Every branch returns immediately. No fall-through, so adding keys or
 * states keeps the exhaustiveness check honest.
 */
export function transition(state: State, event: Event, ctx: TransitionCtx): TransitionResult {
  switch (event.kind) {
    case "sigil-typed":
      if (event.sigil !== ctx.spec.sigil) return { state, effects: [] }
      return {
        state: { kind: "armed", sigil: event.sigil, tokenStart: event.cursor - 1 },
        effects: [],
      }
    case "buffer-changed":
      return onBufferChanged(state, event.text, event.cursor ?? event.text.length, ctx)
    case "key":
      return onKey(state, event.name, ctx)
  }
}

// ---------------------------------------------------------------------------
// buffer-changed branch
// ---------------------------------------------------------------------------

function onBufferChanged(
  state: State,
  text: string,
  cursor: number,
  ctx: TransitionCtx,
): TransitionResult {
  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
  const re = new RegExp(ctx.spec.tokenRe.source, ctx.spec.tokenRe.flags.replace("g", ""))
  const match = re.exec(head)

  // `armMode: "buffer"` sigils (the ampersand and the at-sign) are never
  // dispatched as keys, so the menu must open straight from the buffer.
  // `armMode: "key"` sigils (slash and dollar) require a prior `sigil-typed`
  // event, which keeps the menu from opening on pasted text.
  const armMode = ctx.spec.armMode ?? "buffer"
  if (state.kind === "closed" && (armMode !== "buffer" || !match)) {
    return { state, effects: [] }
  }

  const tokenStart = match ? match.index + (match[1]?.length ?? 0) : -1

  // The active token must still be the one the menu armed on. A buffer-arm
  // sigil has no prior arm, so any live match counts.
  const armedStart = state.kind === "closed" ? -1 : state.tokenStart
  const mismatch =
    !match ||
    head[tokenStart] !== ctx.spec.sigil ||
    (armMode === "key" && tokenStart !== armedStart)
  if (mismatch) {
    if (state.kind === "armed") return { state: CLOSED, effects: [] }
    if (state.kind === "open") return { state: CLOSED, effects: [{ kind: "clear-footer" }] }
    return { state, effects: [] }
  }

  const query = match[2] ?? ""
  const prevQuery = state.kind === "open" ? state.query : null
  const next: State = {
    kind: "open",
    sigil: ctx.spec.sigil,
    query,
    tokenStart,
    tokenEnd: head.length,
    selectedIndex: state.kind === "open" && prevQuery === query ? state.selectedIndex : 0,
    scrollOffset: state.kind === "open" ? state.scrollOffset : 0,
  }

  return { state: next, effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }] }
}

// ---------------------------------------------------------------------------
// key branch
// ---------------------------------------------------------------------------

function onKey(state: State, key: KeyName, ctx: TransitionCtx): TransitionResult {
  // When the menu is closed, the editor.key channel is observed but every
  // key passes through to the default handler.
  if (state.kind !== "open") return { state, effects: [] }

  const items = filteredItems(state, ctx)
  if (items.length === 0) {
    // Menu is open but nothing matches the filter. Nav/select keys become
    // no-ops; Esc still dismisses; Enter and Tab fall through.
    if (key === "Escape") {
      return { state: CLOSED, effects: [{ kind: "clear-footer" }, { kind: "halt-key" }] }
    }
    return { state, effects: [] }
  }

  switch (key) {
    case "ArrowDown": {
      const idx = Math.min(items.length - 1, state.selectedIndex + 1)
      const next: State = { ...state, selectedIndex: idx }
      return {
        state: next,
        effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }, { kind: "halt-key" }],
      }
    }
    case "ArrowUp": {
      const idx = Math.max(0, state.selectedIndex - 1)
      const next: State = { ...state, selectedIndex: idx }
      return {
        state: next,
        effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }, { kind: "halt-key" }],
      }
    }
    case "Tab": {
      const selected = items[state.selectedIndex]
      if (!selected || selected.disabled) {
        return { state, effects: [{ kind: "halt-key" }] }
      }
      const completed = completeIntoBuffer(ctx.bufferText ?? "", state, selected.slug, true)
      return {
        state: CLOSED,
        effects: [
          { kind: "clear-footer" },
          { kind: "set-buffer", text: completed.text, cursor: completed.cursor },
          { kind: "halt-key" },
        ],
      }
    }
    case "Enter": {
      const selected = items[state.selectedIndex]
      if (!selected || selected.disabled) {
        return { state, effects: [{ kind: "halt-key" }] }
      }
      // Insert the NAME token with a trailing space. The trailing space is
      // load-bearing: it breaks the active-token match so the async
      // buffer.changed re-open cannot immediately pop the menu back up, and
      // it leaves the caret ready for appended context.
      const completed = completeIntoBuffer(ctx.bufferText ?? "", state, selected.slug, true)
      return {
        state: CLOSED,
        effects: [
          { kind: "clear-footer" },
          { kind: "set-buffer", text: completed.text, cursor: completed.cursor },
          { kind: "halt-key" },
        ],
      }
    }
    case "Alt+Enter": {
      const selected = items[state.selectedIndex]
      if (!selected || selected.disabled) {
        return { state, effects: [{ kind: "halt-key" }] }
      }
      const body = ctx.spec.bodyFor?.(selected) ?? null
      if (body === null) {
        // No body resolver: degrade to name insert so the key is never dead.
        const completed = completeIntoBuffer(ctx.bufferText ?? "", state, selected.slug, true)
        return {
          state: CLOSED,
          effects: [
            { kind: "clear-footer" },
            { kind: "set-buffer", text: completed.text, cursor: completed.cursor },
            { kind: "halt-key" },
          ],
        }
      }
      const inserted = replaceTokenWithBody(ctx.bufferText ?? "", state, body)
      return {
        state: CLOSED,
        effects: [
          { kind: "clear-footer" },
          { kind: "set-buffer", text: inserted.text, cursor: inserted.cursor },
          { kind: "halt-key" },
        ],
      }
    }
    case "Escape": {
      // Close menu, keep buffer as-is so the user can backspace it away.
      return { state: CLOSED, effects: [{ kind: "clear-footer" }, { kind: "halt-key" }] }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace the active token while preserving text before and after it.
 *
 * `trailingSpace` appends a space after the inserted slug (Tab/Enter). It is
 * what keeps the async buffer.changed re-open from immediately re-arming.
 */
export function completeIntoBuffer(
  text: string,
  state: Extract<State, { kind: "open" }>,
  slug: string,
  trailingSpace: boolean,
): { text: string; cursor: number } {
  const insert = `${state.sigil}${slug}${trailingSpace ? " " : ""}`
  const before = text.slice(0, state.tokenStart)
  const after = text.slice(state.tokenEnd)
  return { text: before + insert + after, cursor: before.length + insert.length }
}

/** Replace the active token with an expanded body, preserving surroundings. */
export function replaceTokenWithBody(
  text: string,
  state: Extract<State, { kind: "open" }>,
  body: string,
): { text: string; cursor: number } {
  const before = text.slice(0, state.tokenStart)
  const after = text.slice(state.tokenEnd)
  return { text: before + body + after, cursor: before.length + body.length }
}

/** Map a flat offset into the editor's multiline row/column coordinates. */
export function offsetToRowCol(text: string, offset: number): { row: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const lines = text.split("\n")
  let remaining = clamped
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? ""
    if (remaining <= line.length) return { row, col: remaining }
    remaining -= line.length + 1
  }
  const row = Math.max(0, lines.length - 1)
  return { row, col: lines[row]?.length ?? 0 }
}

/** Scope items by the spec's categories and apply scoring. */
export function filteredItems(
  state: Extract<State, { kind: "open" }>,
  ctx: TransitionCtx,
): ScoredItem[] {
  const pool = filterByCategories(ctx.allItems, ctx.spec.categories)
  return applySortMode(scoreItems(pool, state.query), "match-score")
}

/** Pure: state to paint lines. The renderer is also pure. */
export function paintLines(state: Extract<State, { kind: "open" }>, ctx: TransitionCtx): string[] {
  const items = filteredItems(state, ctx)
  const overlayState: OverlayState = {
    trigger: state.sigil,
    query: state.query,
    items,
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, items.length - 1)),
    scrollOffset: state.scrollOffset,
    maxRows: ctx.maxRows ?? 5,
    cols: ctx.cols,
    contextWindow: ctx.contextWindow,
    enterVerb: ctx.spec.enterVerb,
    bodyVerb: ctx.spec.bodyVerb,
    footerNote: ctx.spec.footerNote,
  }
  return renderOverlay(overlayState)
}
