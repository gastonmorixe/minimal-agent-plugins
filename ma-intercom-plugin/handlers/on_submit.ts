/**
 * `prompt.submitted` event handler: records the latest user prompt as this
 * session's presence "activity" label, so peers inspecting the roster see what
 * it's working on (e.g. "refactoring the auth store").
 *
 * Why `prompt.submitted` and not `turn.didStart`? The agent reliably emits
 * `prompt.submitted` to the plugin event bus today (it's what the history
 * plugin consumes); the `turn.*` lifecycle channels are declared in the host's
 * channel catalog but not yet emitted at runtime. We bind to the signal that
 * actually fires. The busy/idle PHASE is derived separately in the heartbeat
 * from the session transcript's modification time (see `handlers/beat.ts`), so
 * presence stays correct even between prompts and across resume.
 *
 * @module handlers/on_submit
 */

import { presenceDisabled } from "../lib/config.ts"
import type { EventHandlerContext } from "../lib/host-types.ts"
import { selfIdentity } from "../lib/identity.ts"
import { selfStatePath, updateSelfState } from "../lib/selfstate.ts"

/** Clip a submitted prompt into a short activity label. */
function activityFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>
  const text = typeof p.text === "string" ? p.text : null
  if (!text) return null
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > 0 ? oneLine.slice(0, 100) : null
}

/** Event handler for `prompt.submitted`. */
export default async function onSubmit(ctx: EventHandlerContext): Promise<void> {
  if (presenceDisabled(ctx.env)) return
  const self = selfIdentity(ctx.agent)
  if (!self) return
  const activity = activityFromPayload(ctx.payload)
  if (!activity) return
  updateSelfState(selfStatePath(self.sid, ctx.env), { activity }, new Date().toISOString())
}
