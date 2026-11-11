/**
 * `turn.willStart` hook: close the idle window.
 *
 * The time between the last turn end and this turn start is idle time.
 * A long pause is stored as an idle gap. Duration math then skips it, so
 * a task started yesterday does not show "20h" for a few minutes of work.
 *
 * Observation only. Never halts or rewrites the turn. Never throws.
 *
 * @module tasks/handlers/on_turn_start
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { TaskStore } from "../lib/store.ts"

/** Close the idle window when a turn starts. */
export default function onTurnStart(_payload: unknown, ctx: HookHandlerContext): void {
  try {
    const sid = ctx.agent?.sessionId
    if (!sid) return
    new TaskStore(sid, ctx.env.HOME ? { home: ctx.env.HOME } : {}).markTurnStart()
  } catch (error) {
    ctx.log.warn("tasks: idle start tracking failed", error)
  }
}
