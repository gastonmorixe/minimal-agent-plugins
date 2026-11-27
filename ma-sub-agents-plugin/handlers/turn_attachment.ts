/**
 * Turn-attachment factory: the per-turn `<ma::agent::subagents>` fleet
 * digest producer.
 *
 * Declared in `manifest.json` under `turnAttachments`; the host loader
 * resolves this module through its runtime-discovery seam and registers
 * the default export into the host's turn-attachment registry. At boot
 * the host calls it with the live session context and threads the
 * returned producer into the agent's per-turn attachment seam.
 *
 * Types for the host envelope are re-declared locally (structural
 * typing); this module imports nothing from the host repo.
 *
 * @module sub-agents/handlers/turn_attachment
 */

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

import { SubagentsAttachment } from "../lib/attachment.ts"
import { createWorkerMailboxDrain, mailboxPathFor } from "../lib/mailbox.ts"
import { resolveSessionsDir } from "../lib/runtime.ts"
import { ENV_ID, ENV_LEAD } from "../lib/spawn-plan.ts"

/** Local structural slice of the host's `TurnAttachmentContext`. */
interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
  /** The session sideband API. It renders the tag. */
  sideband?: SidebandApi
}

/**
 * Build the fleet digest producer (for a lead) or the push mailbox drain (for
 * a worker).
 *
 * Inside a worker (`ENV_LEAD` + `ENV_ID` set), returns a `TurnContentDrain`
 * (`consumeAll`) so core automatically injects unread steering/handoff mailbox
 * messages between tool rounds at zero idle token cost.
 */
export default function makeSubagentsAttachment(
  ctx: TurnAttachmentContext,
):
  | SubagentsAttachment
  | { toAttachment: () => null; consumeAll: () => { type: "text"; text: string }[] } {
  const leadSid = process.env[ENV_LEAD]?.trim()
  const workerId = process.env[ENV_ID]?.trim()
  if (leadSid && workerId) {
    const path = mailboxPathFor(resolveSessionsDir(process.env), leadSid)
    const drain = createWorkerMailboxDrain(path, workerId)
    return {
      toAttachment: () => null,
      consumeAll: drain.consumeAll,
    }
  }
  return new SubagentsAttachment(ctx.sessionId, {}, Date.now, ctx.sideband)
}
