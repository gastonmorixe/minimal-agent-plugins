/**
 * `Inbox` — read my received intercom messages on demand.
 *
 * Primary delivery is automatic (the per-turn `<ma::agent::intercom-inbox>`
 * attachment renders new messages). This tool is for re-checking or reviewing
 * history ("show me what I've received"). It advances only the manual `read`
 * marker, never `seen`/`woken`, so it never suppresses automatic delivery.
 *
 * @module handlers/inbox
 */

import { advanceCursor, readCursor } from "../lib/cursors.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { selfIdentity } from "../lib/identity.ts"
import { readInbox } from "../lib/inbox.ts"
import { cursorPath, inboxPath } from "../lib/paths.ts"
import { renderInboxDisplay } from "../lib/render.ts"
import { gray } from "../lib/style.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

/** Tool handler for `Inbox`. */
export default async function inboxHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Inbox: unexpected trigger", is_error: true }
  }
  const self = selfIdentity(ctx.agent)
  if (!self) {
    return {
      kind: "tool_result",
      content: "Inbox: no session id available; intercom is inactive for this run.",
      is_error: true,
    }
  }
  const input = ctx.trigger.input
  const scope = str(input.scope) ?? "unread"
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 20
  const asJson = str(input.format) === "json"

  const path = inboxPath(self.sid, ctx.env)
  const all = readInbox(path)
  const cursor = readCursor(cursorPath(self.sid, ctx.env))

  const selected = scope === "recent" ? all.slice(-limit) : all.slice(cursor.read).slice(-limit)

  // Advance only the manual `read` marker (merge-on-write so we never roll back
  // the attachment's `seen` or the heartbeat's `woken`). Never touches seen, so
  // this tool can't suppress automatic per-turn delivery.
  advanceCursor(cursorPath(self.sid, ctx.env), { read: all.length })

  const header = gray(`${selected.length}/${all.length}`)
  if (selected.length === 0) {
    return {
      kind: "tool_result",
      content: scope === "recent" ? "Inbox empty." : "No unread intercom messages.",
      displayHeader: header,
    }
  }

  if (asJson) {
    return {
      kind: "tool_result",
      content: JSON.stringify(selected, null, 2),
      displayHeader: header,
      display: renderInboxDisplay(selected),
    }
  }

  const lines: string[] = [`${selected.length} message(s)${scope === "unread" ? " (unread)" : ""}:`]
  for (const e of selected) {
    lines.push(`[${e.kind}] from ${e.from.short} (${e.from.model || "?"}) id=${e.id} at ${e.ts}`)
    for (const bl of e.body.split("\n")) lines.push(`    ${bl}`)
  }
  return {
    kind: "tool_result",
    content: lines.join("\n"),
    displayHeader: header,
    display: renderInboxDisplay(selected),
  }
}
