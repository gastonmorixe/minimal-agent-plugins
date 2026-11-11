/**
 * `turn.didEnd` and `turn.aborted` hook: open an idle window.
 *
 * From this moment the agent waits for the user. The next turn start
 * decides if the wait was long enough to count as an idle gap.
 *
 * Observation only. Never throws.
 *
 * @module tasks/handlers/on_turn_end
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { TaskStore } from "../lib/store.ts"

/** Open an idle window when a turn ends or aborts. */
export default function onTurnEnd(_payload: unknown, ctx: HookHandlerContext): void {
  try {
    const sid = ctx.agent?.sessionId
    if (!sid) return
    new TaskStore(sid, ctx.env.HOME ? { home: ctx.env.HOME } : {}).markTurnEnd()
  } catch (error) {
    ctx.log.warn("tasks: idle end tracking failed", error)
  }
}
