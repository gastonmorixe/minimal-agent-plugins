/**
 * `Send` — message another session: a note, a ping, an interrupt, or a
 * broadcast. Thin handler: validate input, call the service, render.
 *
 * @module handlers/send
 */

import { isMessageKind, type MessageKind } from "../lib/envelope.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { send, serviceDepsFromAgent } from "../lib/service.ts"
import { bold, cyan, dim, gray, red, yellow } from "../lib/style.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

const ICON = "⇆"

/** Tool handler for `Send`. */
export default async function sendHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Send: unexpected trigger", is_error: true }
  }
  const input = ctx.trigger.input
  const deps = serviceDepsFromAgent(ctx.agent, ctx.env)
  if (!deps) {
    return {
      kind: "tool_result",
      content: "Send: no session id available; intercom is inactive for this run.",
      is_error: true,
    }
  }

  const to = str(input.to)
  const body = str(input.body)
  if (!to) {
    return {
      kind: "tool_result",
      content: "Send: `to` is required (a peer short id, full sid, `all`, or `project`).",
      is_error: true,
    }
  }
  if (!body) {
    return { kind: "tool_result", content: "Send: `body` is required.", is_error: true }
  }
  const kindRaw = input.kind
  if (kindRaw !== undefined && !isMessageKind(kindRaw)) {
    return {
      kind: "tool_result",
      content: `Send: invalid kind ${JSON.stringify(kindRaw)} (use note | ping | interrupt).`,
      is_error: true,
    }
  }
  const kind: MessageKind = isMessageKind(kindRaw) ? kindRaw : "note"
  const replyTo = str(input.replyTo)

  const outcome = send(deps, {
    to,
    body,
    kind,
    ...(replyTo ? { replyTo } : {}),
    fromCwd: ctx.cwd,
  })

  const kindGlyph = kind === "interrupt" ? red("⛔") : kind === "ping" ? yellow("‼") : cyan("✉")
  const header = `${cyan(ICON)} ${bold(deps.self.short)} ${dim("·")} ${gray(`send ${kind} → ${outcome.scope}`)}`

  if (outcome.delivered.length === 0) {
    const why =
      outcome.skipped.map((s) => `${s.ref}: ${s.reason}`).join("; ") || "no reachable recipients"
    return {
      kind: "tool_result",
      content: `Not delivered (${why}). Tip: run Peers to see who is online.`,
      is_error: true,
      displayHeader: header,
    }
  }

  const names = outcome.delivered.map((d) => d.short).join(", ")
  const skipNote =
    outcome.skipped.length > 0
      ? ` (skipped ${outcome.skipped.map((s) => `${s.ref}: ${s.reason}`).join("; ")})`
      : ""
  const wake =
    kind === "note"
      ? " It waits in their inbox until their next turn."
      : " They will be woken between turns."
  return {
    kind: "tool_result",
    content: `Delivered ${kind} to ${outcome.delivered.length} session(s): ${names}.${skipNote}${wake} (envelope ${outcome.envelopeId})`,
    displayHeader: header,
    display: `  ${kindGlyph} ${dim(`to ${names}`)}`,
  }
}
