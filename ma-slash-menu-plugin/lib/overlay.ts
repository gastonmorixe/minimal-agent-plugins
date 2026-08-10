/**
 * Pure overlay state machine for the slash-menu.
 *
 * # Design
 *
 * **Functional core, imperative shell**: this module is the *core*.
 * No I/O, no globals, no clocks. The handlers (`handlers/on_key.ts`,
 * `handlers/on_buffer_changed.ts`) are the *shell* — they observe the
 * editor, call `transition()`, and apply the returned effects.
 *
 * **Discriminated union state**: `State.kind` is `"closed" | "open"`.
 * TypeScript narrows correctly inside switches, so impossible states
 * cannot be constructed.
 *
 * **Reducer signature**: `transition(state, event, ctx) → {state, effects}`.
 * Pure; for the same inputs, the output is always identical. Easy to
 * unit-test exhaustively.
 *
 * @module ma-slash-menu/lib/overlay
 */

import { renderOverlay } from "./render.ts"
import { applySortMode, scoreItems } from "./scoring.ts"
import type { Item, OverlayState, ScoredItem, Trigger } from "./types.ts"

// ---------------------------------------------------------------------------
// Activation regex
// ---------------------------------------------------------------------------

/**
 * The menu is open only when its state has been armed by a typed sigil, then
 * the cursor remains immediately after that sigil's contiguous identifier.
 *
 * Typing `explain /conf` → open with query "conf".
 * Typing `explain /config ` → menu closes (the user is now composing args).
 */
const ACTIVE_TOKEN_RE = /([/$])([a-zA-Z0-9_-]*)$/

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type State =
  | { readonly kind: "closed" }
  | { readonly kind: "armed"; readonly trigger: Trigger; readonly tokenStart: number }
  | {
      readonly kind: "open"
      readonly trigger: Trigger
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
  | { kind: "slash-typed"; trigger: Trigger; cursor: number }
  | { kind: "buffer-changed"; text: string; cursor?: number }
  | { kind: "key"; name: KeyName }

export type KeyName = "Tab" | "Enter" | "Escape" | "ArrowUp" | "ArrowDown"

// ---------------------------------------------------------------------------
// Effects (applied by the shell)
// ---------------------------------------------------------------------------

/**
 * Side-effects the shell should perform. `paint-footer` is the only
 * thing the renderer needs the host to do on every state change; the
 * other effects fire in response to specific keys.
 */
export type Effect =
  | { kind: "paint-footer"; lines: string[] }
  | { kind: "clear-footer" }
  | { kind: "set-buffer"; text: string; cursor?: number }
  | { kind: "halt-key" }
  /**
   * Dispatch a registered slash command directly (the user picked a command
   * row). The shell emits `command.run` on the agent bus with `/<slug>`, so
   * ONE Enter dispatches the command (opening its TUI) instead of the
   * rewrite-buffer-then-submit path that raced the async menu re-open. Only
   * emitted for `act` (command) items; skills still use `set-buffer` + submit.
   */
  | { kind: "run-command"; slug: string }

// ---------------------------------------------------------------------------
// Reducer context (what the shell knows that the core needs)
// ---------------------------------------------------------------------------

export interface TransitionCtx {
  /** All available items from every provider (actions + skills + ...). */
  allItems: readonly Item[]
  /** Terminal column width — drives render's degradation ladder. */
  cols: number
  /** Active model's context window in tokens, for the `$`-mode cost chip. */
  contextWindow?: number
  /** Max rows the menu may display. */
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
 * Apply one event to the FSM. Returns the new state plus any effects
 * the shell should run.
 *
 * **All branches return immediately.** No fall-through. This is a
 * deliberate `switch` shape — easier to extend with new keys / new
 * states without breaking the exhaustiveness check.
 */
export function transition(state: State, event: Event, ctx: TransitionCtx): TransitionResult {
  switch (event.kind) {
    case "slash-typed":
      return {
        state: { kind: "armed", trigger: event.trigger, tokenStart: event.cursor - 1 },
        effects: [],
      }
    case "buffer-changed": {
      // Compatibility for direct pure-FSM callers. The real handler always
      // supplies a cursor, so only real typed sigils can arm the menu.
      if (state.kind === "closed" && event.cursor === undefined) {
        const match = /^([/$])([a-zA-Z0-9_-]*)$/.exec(event.text)
        if (match) {
          state = { kind: "armed", trigger: match[1] as Trigger, tokenStart: 0 }
        }
      }
      return onBufferChanged(state, event.text, event.cursor ?? event.text.length, ctx)
    }
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
  if (state.kind === "closed") return { state, effects: [] }

  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
  const match = ACTIVE_TOKEN_RE.exec(head)
  const tokenStart = match ? head.length - match[0]!.length : -1
  const armedStart = state.kind === "armed" ? state.tokenStart : state.tokenStart

  // Ignore text that was pasted or typed elsewhere. The sigil must have first
  // arrived as its own editor.key event, and the active token must still be it.
  if (!match || tokenStart !== armedStart || match[1] !== state.trigger) {
    if (state.kind === "armed") return { state: CLOSED, effects: [] }
    return { state: CLOSED, effects: [{ kind: "clear-footer" }] }
  }

  const trigger = match[1] as Trigger
  const query = match[2] ?? ""
  const prevQuery = state.kind === "open" ? state.query : null
  const next = {
    kind: "open" as const,
    trigger,
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
  // When the menu is closed, the editor.key channel is observed but
  // every key passes through to the default handler.
  if (state.kind !== "open") return { state, effects: [] }

  const items = filteredItems(state, ctx)
  if (items.length === 0) {
    // Menu is open but nothing matches the filter. Nav/select keys
    // become no-ops; Esc still dismisses; Enter and Tab fall through.
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
      if (!selected || selected.disabled) {
        return { state, effects: [{ kind: "halt-key" }] }
      }
      const completed = completeIntoBuffer(ctx.bufferText ?? "", state, selected.slug, true)
      return {
        // The state stays "open" here for one tick — the next
        // buffer-changed event sees the trailing space and closes it.
        state,
        effects: [
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
      // A registered command row (category "act"): dispatch it DIRECTLY via
      // the host command registry. Halt the key so the editor never submits
      // — the command, not the buffer, owns this Enter. This is what makes
      // ONE Enter open `/config`'s TUI (the old path rewrote the buffer to
      // `/config ` and relied on a follow-up submit, which raced the async
      // buffer-changed re-open and took several Enters + leaked to scrollback).
      if (selected.category === "act") {
        return {
          state: CLOSED,
          effects: [
            { kind: "clear-footer" },
            { kind: "run-command", slug: selected.slug },
            { kind: "halt-key" },
          ],
        }
      }
      // A skill row (model-routed): replace the buffer with `<trigger><slug>`
      // and let the editor's default submit handle the rest. No halt — we
      // want submit to fire on the rewritten buffer.
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
      // Close menu, keep buffer as-is so user can backspace it away or
      // continue typing.
      return {
        state: CLOSED,
        effects: [{ kind: "clear-footer" }, { kind: "halt-key" }],
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace the active slash token while preserving text before and after it. */
export function completeIntoBuffer(
  text: string,
  state: Extract<State, { kind: "open" }>,
  slug: string,
  trailingSpace: boolean,
): { text: string; cursor: number } {
  const insert = `${state.trigger}${slug}${trailingSpace ? " " : ""}`
  const before = text.slice(0, state.tokenStart)
  const after = text.slice(state.tokenEnd)
  return { text: before + insert + after, cursor: before.length + insert.length }
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

/** Scope items by trigger ('/' = all, ' = skills only) and apply scoring. */
export function filteredItems(
  state: Extract<State, { kind: "open" }>,
  ctx: TransitionCtx,
): ScoredItem[] {
  const pool =
    state.trigger === "$"
      ? ctx.allItems.filter((i) => i.category === "skl")
      : (ctx.allItems as Item[])
  return applySortMode(scoreItems(pool as Item[], state.query), "match-score")
}

/** Pure: state → paint lines. The renderer is also pure. */
function paintLines(state: Extract<State, { kind: "open" }>, ctx: TransitionCtx): string[] {
  const items = filteredItems(state, ctx)
  const overlayState: OverlayState = {
    trigger: state.trigger,
    query: state.query,
    items,
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, items.length - 1)),
    scrollOffset: state.scrollOffset,
    maxRows: ctx.maxRows ?? 5,
    cols: ctx.cols,
    contextWindow: ctx.contextWindow,
  }
  return renderOverlay(overlayState)
}
