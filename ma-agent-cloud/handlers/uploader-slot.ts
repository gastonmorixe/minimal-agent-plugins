/**
 * The uploader live-area slot — the automatic teleport flush trigger.
 *
 * A live-area slot is the natural "between-turns, never-blocking" hook: the host
 * runs it periodically with an in-flight guard, off the turn loop. Each tick we
 * flush this session's new records best-effort and paint a tiny ambient status
 * line (or nothing when logged out, so the footer stays clean for non-cloud
 * users).
 *
 * Records are written to the JSONL as a turn streams, so by the time the slot
 * ticks after a turn there are new complete lines to ship — this is the
 * "flush-at-turn-boundary" trigger Steve preferred, realized as a periodic slot
 * (simpler + more robust than a file watcher, and the cursor + dedupe make the
 * exact timing irrelevant).
 *
 * @module handlers/uploader-slot
 */

import { currentFlags, isEnabled } from "../lib/feature-flags.ts"
import type { LiveAreaHandlerContext } from "../lib/host-types.ts"
import { ensureRelay, injectorFor } from "../lib/relay-session.ts"
import { loadAuth } from "../lib/token-store.ts"

import { flushForSession } from "./push.ts"

/** Live-area slot handler: best-effort flush this session to the cloud each tick. */
export default async function uploaderSlot(ctx: LiveAreaHandlerContext): Promise<string | null> {
  const sid = ctx.agent?.sessionId?.trim()
  if (!sid) return null

  // Cheap pre-gate so a logged-out user pays nothing and sees no footer row.
  if (!loadAuth(ctx.env)) return null
  if (!isEnabled(currentFlags(ctx.env), "cloudEnabled")) return null

  // Phase D: ensure the pending-prompt relay is running for this session (drains
  // the backlog + opens the live pendingPromptAdded subscription on first tick).
  // Gated inside ensureRelay; a no-op when teleport is off. Wires prompt.inject
  // via the host emit so a claimed prompt actually runs as a turn.
  if (ctx.emit) ensureRelay(sid, ctx.emit, ctx.env)

  // The relay's injector (if active) stamps pendingId onto the user record a
  // claimed prompt produces, so web/mobile reconcile. Null ⇒ no stamp (identity).
  const injector = injectorFor(sid)
  const outcome = await flushForSession(
    sid,
    ctx.env,
    injector ? (r) => injector.stampPendingId(r) : undefined,
  )
  if (!outcome.ok) {
    // Network/backend hiccup: never fatal. Show a faint "retrying" so the user
    // knows uploads are pending, not lost (local JSONL is the source of truth).
    return "☁ teleport · sync pending"
  }
  switch (outcome.status) {
    case "uploaded":
      return `☁ teleport · synced ↑${outcome.sent} (line ${outcome.acceptedThroughClientLine})`
    case "nothing-new":
      return "☁ teleport · up to date"
    case "skipped":
      // logged in but cloud/teleport flag off, or no file yet — quiet row.
      return null
  }
}
