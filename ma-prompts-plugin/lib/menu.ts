/**
 * The `&` autocomplete namespace: a {@link TriggerSpec} plus shared state.
 *
 * This is the whole "another sigil" surface. The FSM, scoring, rendering and
 * style spans all come from `ma-autocomplete-kit`; this module only describes
 * what makes the prompts menu the prompts menu.
 *
 * State is a per-process singleton so the `editor.key` and
 * `editor.buffer.changed` handlers share one FSM instance (ESM dynamic-import
 * caches by URL, so both handlers resolve to this same module).
 *
 * @module lib/menu
 */

import { CLOSED, type Item, type Provider, type State, type TriggerSpec } from "ma-autocomplete-kit"

import type { PromptsConfig } from "./config.ts"
import { makePromptsProvider } from "./provider.ts"
import type { StoreDeps } from "./store.ts"

/** Build the `&` trigger spec for the given sigil. */
export function makePromptSpec(sigil: string): TriggerSpec {
  // Escape the sigil for use in a regex (covers `&`, `$`, `@`, `+`, etc.).
  const s = sigil.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return {
    sigil,
    tokenRe: new RegExp(`(^|[\\s([{])${s}([a-zA-Z0-9_-]*)$`),
    spanRe: new RegExp(`(^|[\\s([{])${s}([a-zA-Z0-9_-]*)`, "g"),
    categories: ["prm"],
    enterVerb: "insert name",
    bodyVerb: "insert body",
    sigilColor: "lime",
    bodyFor: (item: Item) => {
      const payload = item.payload as { body?: string } | undefined
      return payload?.body ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// Per-process state
// ---------------------------------------------------------------------------

let fsmState: State = CLOSED
let cachedItems: Item[] | null = null

/** Read the current overlay FSM state. */
export function getFsmState(): State {
  return fsmState
}

/** Replace the overlay FSM state. */
export function setFsmState(next: State): void {
  fsmState = next
}

/** The provider for the configured store deps. */
export function providerFor(deps: StoreDeps): Provider {
  return makePromptsProvider(deps)
}

/** Read the cached items, refreshing from the provider on first use. */
export async function getItems(provider: Provider): Promise<readonly Item[]> {
  if (cachedItems === null) {
    cachedItems = await provider.list()
  }
  return cachedItems
}
/** Invalidate the item cache so the next read re-lists from disk. */
export function invalidateItems(): void {
  cachedItems = null
}

/** Test hook: reset FSM + cache. */
export function _resetForTests(): void {
  fsmState = CLOSED
  cachedItems = null
}

/** Test hook: inject a fixed item list (skips disk discovery). */
export function _setItemsForTests(items: Item[] | null): void {
  cachedItems = items
}

/** The active spec from config. */
export function specFor(config: PromptsConfig): TriggerSpec {
  return makePromptSpec(config.sigil)
}
