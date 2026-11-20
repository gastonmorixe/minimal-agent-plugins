/**
 * `turn.didEnd` and `turn.aborted` listener: the end of a run.
 *
 * It deletes the state of the session (see `lib/state.ts`). Thus:
 *
 * - The silence count does not go into the next run. An ack in the last
 *   response of a run (a text-only response) does not silence a checkpoint
 *   of the next run. An ack in the first response of the next run stays,
 *   because it arrives after this event. This is the rule of the old core,
 *   which set the count to 0 at the start of each run.
 * - The map of sessions does not keep an entry for a session that is idle.
 *
 * Observation only. Never throws.
 *
 * @module handlers/run-end
 */

import type { HookContext } from "../lib/host-types.ts"
import { endRun, sessionKey } from "../lib/state.ts"

/** The manifest hook entry. */
export default function onRunEnd(_payload: unknown, ctx: Pick<HookContext, "agent" | "env">): void {
  try {
    endRun(sessionKey(ctx.agent, ctx.env))
  } catch {
    // Observation only.
  }
}
