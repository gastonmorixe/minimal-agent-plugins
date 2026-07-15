/**
 * Shared per-process state for the at-mention peer autocomplete.
 *
 * Handlers (`on_key`, `on_buffer_changed`, `on_turn_will_start`) import this
 * module. ESM dynamic-import caches by URL, so dual-import resolves to the
 * same module instance — one singleton FSM state, one shared peer roster cache.
 *
 */

import type { RosterRow } from "../roster.ts"

import { CLOSED, type State } from "./overlay.ts"
import type { PeerCandidate } from "./types.ts"

/** FSM state (per-process). */
let fsmState: State = CLOSED

/** Cached peer candidates (exclude-self roster snapshot). */
let peerCache: PeerCandidate[] = []

/** Read the current overlay FSM state. */
export function getFsmState(): State {
  return fsmState
}

/** Replace the overlay FSM state. */
export function setFsmState(next: State): void {
  fsmState = next
}

/** Read the cached peer candidates. */
export function getPeers(): readonly PeerCandidate[] {
  return peerCache
}

/**
 * Replace the peer cache from a roster snapshot (exclude self already applied
 * by the caller, or filtered here via `isSelf`).
 */
export function setPeersFromRoster(rows: readonly RosterRow[]): void {
  const next: PeerCandidate[] = []
  for (const r of rows) {
    if (r.isSelf) continue
    const cand: PeerCandidate = {
      sid: r.record.sid,
      short: r.record.short,
      pid: r.record.pid,
      model: r.record.model,
      cwd: r.record.cwd,
      liveness: r.liveness,
    }
    if (r.record.name) {
      // name is optional on PeerCandidate; assign without object-spread in map.
      ;(cand as { name?: string }).name = r.record.name
    }
    next.push(cand)
  }
  peerCache = next
}

/** Direct inject for tests / handlers that already hold candidates. */
export function setPeers(peers: readonly PeerCandidate[]): void {
  peerCache = [...peers]
}

/** Test hook: discard FSM + peer cache. */
export function _resetForTests(): void {
  fsmState = CLOSED
  peerCache = []
}
