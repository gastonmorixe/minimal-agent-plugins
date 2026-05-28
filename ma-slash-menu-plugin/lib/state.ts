/**
 * Shared per-process state for the slash-menu plugin.
 *
 * Both handlers (`handlers/on_key.ts` and `handlers/on_buffer_changed.ts`)
 * import this module. ESM dynamic-import caches by URL, so the plugin
 * loader's dual-import resolves to the **same module instance** — one
 * singleton FSM state, one shared items cache.
 *
 * # Why a singleton?
 *
 * The FSM tracks "is the menu open right now, what's selected, what's
 * the query". That's per-session, not per-event. Threading it through
 * the loader's ctx would require a ctx field that doesn't exist; the
 * singleton is the smallest workable shape.
 *
 * # Why not on `ctx.env`?
 *
 * `env` is a `Record<string,string>` snapshot, not a mutable holder.
 *
 * # Lifetime
 *
 * The process. There's no shutdown hook; the OS reclaims it.
 *
 * @module ma-slash-menu/lib/state
 */

import { actionsProvider } from "../providers/actions.ts"
import { defaultSkillsDeps, listSkills } from "../providers/skills.ts"

import { CLOSED, type State } from "./overlay.ts"
import type { Item } from "./types.ts"

/** FSM state (per-process). */
let fsmState: State = CLOSED

export function getFsmState(): State {
  return fsmState
}

export function setFsmState(next: State): void {
  fsmState = next
}

// ---------------------------------------------------------------------------
// Items cache
// ---------------------------------------------------------------------------

let cachedItems: Item[] | null = null

/**
 * Aggregate all provider items. Cached per-process; the loader doesn't
 * call our `refreshOn` bus events for us yet, so re-reading is a manual
 * thing the user triggers by quitting and re-launching.
 */
export function getItems(): readonly Item[] {
  if (cachedItems) return cachedItems
  const actions = actionsProvider.list() as Item[]
  const skills = listSkills(defaultSkillsDeps())
  cachedItems = [...actions, ...skills]
  return cachedItems
}

/** Test hook: discard the cache (force re-read on next `getItems`). */
export function _resetForTests(): void {
  fsmState = CLOSED
  cachedItems = null
}
