/**
 * Turn-attachment factory: the per-turn `<ma::agent::intercom-inbox>` producer.
 *
 * This is intercom's PASSIVE content-delivery channel. Once per `Agent.run`,
 * the host calls `toAttachment()`; we read inbox envelopes past the `seen`
 * cursor, render them into an `<ma::agent::intercom-inbox>` block prepended to
 * the first user message, and advance `seen`. Cache-friendly (rides the
 * rolling-tail breakpoint, like `<ma::agent::tasks>`) and zero-cost when the
 * inbox is empty (returns null).
 *
 * Each message is shown exactly once (the `seen` high-water mark); the model is
 * told to dedup on envelope `id` as a safety net for the at-least-once replay
 * window.
 *
 * The `<ma::agent::*>` namespace marks this as "runtime → model, data the model
 * reads", never a model-emitted trigger (those are `<ma::emit::*>`). Verified
 * to be stripped by the core session-replay tag scrubber.
 *
 * @module handlers/inbox_attachment
 */

import { advanceCursor, type Cursor, readCursor } from "../lib/cursors.ts"
import type {
  AttachmentTextBlock,
  TurnAttachmentContext,
  TurnAttachmentProducer,
} from "../lib/host-types.ts"
import { drainFrom } from "../lib/inbox.ts"
import { cursorPath } from "../lib/paths.ts"
import { renderInboxBody } from "../lib/render.ts"
import { makeLocalFsTransport } from "../lib/service.ts"

/**
 * Per-session inbox attachment producer. Constructed once per agent with the
 * live session id; reads the inbox file on each `toAttachment()` call.
 */
export class InboxAttachment implements TurnAttachmentProducer {
  constructor(
    public readonly sid: string | null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  toAttachment(): AttachmentTextBlock | null {
    const sid = this.sid?.trim()
    if (!sid) return null

    // Read the inbox through the Transport port (local fs adapter here — the
    // turn-attachment context carries no host registry, and the inbox owner is
    // always local: me). Byte-identical to the prior `readInbox(inboxPath(...))`.
    const all = makeLocalFsTransport(this.env, sid).readInbox(sid)
    const cpath = cursorPath(sid, this.env)
    const cursor: Cursor = readCursor(cpath)
    const { fresh, nextMark } = drainFrom(all, cursor.seen)
    if (fresh.length === 0) return null

    const body = renderInboxBody(fresh)
    const kinds = countKinds(fresh)
    const attr = `count="${fresh.length}"${kinds.interrupt ? ` interrupt="${kinds.interrupt}"` : ""}`
    const text = `<ma::agent::intercom-inbox ${attr}>\n${body}\n</ma::agent::intercom-inbox>`

    // Advance `seen` so each message is rendered exactly once. Merge-on-write
    // (Math.max) so this never rolls back a concurrent `woken`/`read` advance.
    // If the write fails, the message replays next turn (at-least-once) and the
    // model dedups on envelope id.
    advanceCursor(cpath, { seen: nextMark })
    return { type: "text", text }
  }
}

function countKinds(envs: ReadonlyArray<{ kind: string }>): { message: number; interrupt: number } {
  let message = 0
  let interrupt = 0
  for (const e of envs) {
    if (e.kind === "message") message += 1
    else if (e.kind === "interrupt") interrupt += 1
  }
  return { message, interrupt }
}

/** The factory the host's turn-attachment registry invokes at boot. */
export default function makeInboxAttachment(ctx: TurnAttachmentContext): InboxAttachment {
  return new InboxAttachment(ctx.sessionId)
}
