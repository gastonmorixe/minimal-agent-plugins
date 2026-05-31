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
 * The menu is open iff buffer matches this shape: trigger sigil followed
 * by a contiguous identifier (no whitespace, no extra punctuation).
 *
 * Typing `/conf` → open with query "conf".
 * Typing `/config ` (trailing space) → menu closes (the user is now
 * composing arguments, not browsing).
 */
const TRIGGER_RE = /^([/$])([a-zA-Z0-9_-]*)$/

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type State =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open"
      readonly trigger: Trigger
      readonly query: string
      readonly selectedIndex: number
      readonly scrollOffset: number
    }

export const CLOSED: State = { kind: "closed" }

// ---------------------------------------------------------------------------
// Events (driven by the imperative shell)
// ---------------------------------------------------------------------------

export type Event = { kind: "buffer-changed"; text: string } | { kind: "key"; name: KeyName }

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
  | { kind: "set-buffer"; text: string }
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
    case "buffer-changed":
      return onBufferChanged(state, event.text, ctx)
    case "key":
      return onKey(state, event.name, ctx)
  }
}

// ---------------------------------------------------------------------------
// buffer-changed branch
// ---------------------------------------------------------------------------

function onBufferChanged(state: State, text: string, ctx: TransitionCtx): TransitionResult {
  const match = TRIGGER_RE.exec(text)

  if (!match) {
    // Buffer no longer matches an active trigger shape.
    if (state.kind === "closed") return { state, effects: [] }
    return { state: CLOSED, effects: [{ kind: "clear-footer" }] }
  }

  const trigger = match[1] as Trigger
  const query = match[2] ?? ""

  // Compute next-open state, preserving selectedIndex when possible.
  const prevQuery = state.kind === "open" ? state.query : null
  const prevTrigger = state.kind === "open" ? state.trigger : null
  const next = {
    kind: "open" as const,
    trigger,
    query,
    selectedIndex:
      state.kind === "open" && prevTrigger === trigger && prevQuery === query
        ? state.selectedIndex
        : 0,
    scrollOffset: state.kind === "open" ? state.scrollOffset : 0,
  }

  return {
    state: next,
    effects: [{ kind: "paint-footer", lines: paintLines(next, ctx) }],
  }
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
      // Complete to `<trigger><slug> `. Trailing space takes the buffer
      // out of the trigger regex → next `buffer-changed` transitions to
      // CLOSED. User keeps typing args.
      const selected = items[state.selectedIndex]
      if (!selected || selected.disabled) {
        return { state, effects: [{ kind: "halt-key" }] }
      }
      const next = `${state.trigger}${selected.slug} `
      return {
        // The state stays "open" here for one tick — the next
        // buffer-changed event will transition us to "closed".
        state,
        effects: [{ kind: "set-buffer", text: next }, { kind: "halt-key" }],
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
      const next = `${state.trigger}${selected.slug}`
      return {
        state: CLOSED,
        effects: [{ kind: "clear-footer" }, { kind: "set-buffer", text: next }],
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

/** Scope items by trigger ('/' = all, '$' = skills only) and apply scoring. */
export function filteredItems(
  state: Extract<State, { kind: "open" }>,
  ctx: TransitionCtx,
): ScoredItem[] {
  const pool =
    state.trigger === "$"
      ? ctx.allItems.filter((i) => i.category === "skl")
      : (ctx.allItems as Item[])
  const scored = scoreItems(pool as Item[], state.query)
  return applySortMode(scored, "match-score")
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
