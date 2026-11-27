/**
 * `Mailbox` — opt-in sibling coordination over a shared durable board. A worker
 * `post`s a short message to a specific sibling (`to`) or broadcasts (`to:"*"`),
 * and `read`s messages addressed to it or broadcast. Identity comes from the
 * spawn env (a worker is its handle, e.g. "A2"; the lead is "lead").
 *
 * Pull-based by design: this is why it works across processes where a push
 * channel would not. Bounded; use only when coordinating.
 *
 * @module sub-agents/handlers/mailbox
 */

import { serviceDepsFromCtx, storeFromCtx } from "../lib/handler-deps.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import {
  DEFAULT_MAIL_KIND,
  type MailMessage,
  makeMailId,
  postMessage,
  readMailbox,
  visibleTo,
} from "../lib/mailbox.ts"
import { resolveSessionsDir } from "../lib/runtime.ts"
import { resumeAgent } from "../lib/service.ts"
import { ENV_ID, ENV_LEAD } from "../lib/spawn-plan.ts"
import { ANSI, color, GLYPHS } from "../lib/style.ts"
import { isActive } from "../lib/types.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function fmt(m: MailMessage): string {
  const ts = m.ts.length >= 19 ? m.ts.slice(11, 19) : ""
  const arrow = m.to === "*" ? "→ all" : `→ ${m.to}`
  return `${ts}  ${m.from} ${arrow} [${m.kind}] ${m.body}`
}

/**
 * Tool handler for `Mailbox`: posts a message to a sibling worker (or
 * broadcast) or reads the caller's addressed + broadcast messages from the
 * shared board.
 */
export default async function mailbox(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Mailbox: unexpected trigger", is_error: true }
  }
  const input = ctx.trigger.input
  const me = str(ctx.env[ENV_ID]) ?? "lead"
  const leadSid = str(ctx.env[ENV_LEAD]) ?? ctx.agent?.sessionId
  if (!leadSid) {
    return { kind: "tool_result", content: "Mailbox: no lead session available.", is_error: true }
  }
  const path = `${resolveSessionsDir(ctx.env)}/${leadSid}.mailbox.jsonl`
  const action = str(input.action) ?? "read"
  const headerIcon = color(true, ANSI.SKY, "✉")

  if (action === "post") {
    const body = str(input.body)
    if (!body)
      return { kind: "tool_result", content: "Mailbox post: `body` is required.", is_error: true }
    const to = str(input.to) ?? "*"
    const kind = str(input.kind) ?? DEFAULT_MAIL_KIND
    // Lead-initiated resume of a terminal worker: continue its existing session
    // (--resume <childSid>) with the follow-up message instead of cold-spawning.
    if (me === "lead" && kind === "resume" && to !== "*") {
      const store = storeFromCtx(ctx)
      const target = store?.get(to)
      if (target && !isActive(target.status)) {
        const deps = serviceDepsFromCtx(ctx)
        if (!deps) {
          return {
            kind: "tool_result",
            content: "Mailbox resume: no lead session available.",
            is_error: true,
          }
        }
        const resumed = await resumeAgent(to, body, deps)
        if (!resumed.ok) return { kind: "tool_result", content: resumed.error, is_error: true }
        return {
          kind: "tool_result",
          content: `Resumed ${resumed.value.id} (${resumed.value.type}, sid ${resumed.value.sid}) with follow-up message.`,
          displayHeader: `${headerIcon} ${color(true, ANSI.BOLD, me)} ${color(true, ANSI.DIM, GLYPHS.bullet)} ${color(true, ANSI.LGRAY, `resume → ${to}`)}`,
          display: body,
        }
      }
    }
    const msg: MailMessage = {
      id: makeMailId(),
      ts: new Date().toISOString(),
      from: me,
      to,
      kind,
      body,
    }
    postMessage(path, msg)
    const targetRec = me === "lead" && to !== "*" ? storeFromCtx(ctx)?.get(to) : null
    const deliveryNote =
      targetRec && isActive(targetRec.status)
        ? " Delivered automatically on its next tool round."
        : ""
    return {
      kind: "tool_result",
      content: `Posted to ${to === "*" ? "all sub-agents" : to} as ${me}.${deliveryNote}`,
      displayHeader: `${headerIcon} ${color(true, ANSI.BOLD, me)} ${color(true, ANSI.DIM, GLYPHS.bullet)} ${color(true, ANSI.LGRAY, `post → ${to}`)} ${color(true, ANSI.DIM, `[${kind}]`)}`,
      display: body,
    }
  }

  // read
  const since = str(input.since)
  const mine = visibleTo(readMailbox(path), me, since).slice(-30)
  const content =
    mine.length === 0
      ? `No messages${since ? " since the cursor" : ""} for ${me}.`
      : `Messages for ${me}:\n${mine.map(fmt).join("\n")}`
  return {
    kind: "tool_result",
    content,
    displayHeader: `${headerIcon} ${color(true, ANSI.BOLD, me)} ${color(true, ANSI.DIM, GLYPHS.bullet)} ${color(true, ANSI.LGRAY, `read (${mine.length})`)}`,
    display:
      mine.length > 0 ? mine.map((m) => color(true, ANSI.DGRAY, fmt(m))).join("\n") : undefined,
  }
}
