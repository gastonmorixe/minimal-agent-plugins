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
 * The FSM tracks "is the menu open right now, what's selected, what's the
 * query". That's per-session, not per-event. Threading it through the
 * loader's ctx would require a ctx field that doesn't exist; the singleton
 * is the smallest workable shape.
 *
 * # Item sourcing
 *
 * Items are `actions ⊕ skills`. **Actions are the host's REGISTERED slash
 * commands**, read live from `ctx.listCommands()` and passed into
 * {@link refreshItems} by each handler before it transitions the FSM. We no
 * longer ship a hardcoded action list — the menu shows exactly the commands
 * that actually dispatch (plus skills discovered on disk). Skills are
 * cached on first build; the command set is refreshed on every handler call
 * (cheap: a `.map` over a small array) so a newly-registered command shows
 * up without a relaunch.
 *
 * @module ma-slash-menu/lib/state
 */

import { commandItems } from "../providers/actions.ts"
import { defaultSkillsDeps, listSkills } from "../providers/skills.ts"

import type { CommandInfo } from "./host-types.ts"
import { CLOSED, type State } from "./overlay.ts"
import type { Item } from "./types.ts"

/** FSM state (per-process). */
let fsmState: State = CLOSED

/** Read the current overlay FSM state. */
export function getFsmState(): State {
  return fsmState
}

/** Replace the overlay FSM state with the given next state. */
export function setFsmState(next: State): void {
  fsmState = next
}

// ---------------------------------------------------------------------------
// Items cache
// ---------------------------------------------------------------------------

let cachedSkills: Item[] | null = null
let commandCache: Item[] = []

/** Discover skills once (disk scan); cached for the process. */
function skills(): Item[] {
  if (!cachedSkills) cachedSkills = listSkills(defaultSkillsDeps())
  return cachedSkills
}

/**
 * Test hook: inject a fixed skills list (skips disk discovery). Pass `null`
 * to clear and re-enable discovery on next {@link getItems}.
 *
 * Integration tests must not depend on the developer's `~/.agents/skills`
 * (CI runners have none).
 */
export function _setSkillsForTests(items: Item[] | null): void {
  cachedSkills = items
}

/**
 * Refresh the action items from the host's live command registry. Called by
 * each handler with `ctx.listCommands?.()` before it runs an FSM transition,
 * so the menu reflects the current command set. A no-op-safe `undefined`
 * (older host) leaves the action set empty.
 */
export function refreshItems(commands: readonly CommandInfo[] | undefined): void {
  commandCache = commandItems(commands ?? [])
}

/**
 * Aggregate all menu items: registered commands (actions) ⊕ discovered
 * skills. Reads the command cache populated by {@link refreshItems}.
 */
export function getItems(): readonly Item[] {
  return [...commandCache, ...skills()]
}

/** Test hook: discard caches + FSM state (force re-read on next use). */
export function _resetForTests(): void {
  fsmState = CLOSED
  cachedSkills = null
  commandCache = []
}
