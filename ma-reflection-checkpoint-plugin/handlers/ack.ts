/**
 * Inline-tag handler for `<ma::emit::reflection-ack silence-for="K" reason="..." />`.
 *
 * The core scanner removes the tag from the visible output and gives this
 * handler the attributes. The handler sets the silence count of the session
 * to K (the next K due checkpoints get no cooldown and no attachment). In
 * place of the tag, the user sees one dim line with K and the reason.
 *
 * Rules (same as the old core parser):
 * - No `silence-for`: K is 1.
 * - `silence-for="0"`, a negative or a bad value: no change, no line.
 * - Interval 0 (checkpoints off): no change, no line.
 *
 * @module handlers/ack
 */

import { pluginConfig } from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { sessionKey, stateFor } from "../lib/state.ts"

/** The parsed ack. */
export interface ReflectionAck {
  silenceFor: number
  reason: string
}

/**
 * Parse the tag attributes.
 *
 * @returns The ack, or `null` when it sets no silence.
 */
export function parseAck(attrs: Record<string, string> | undefined): ReflectionAck | null {
  const raw = attrs?.["silence-for"]
  const silenceFor = raw === undefined ? 1 : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isSafeInteger(silenceFor) || silenceFor <= 0) return null
  return { silenceFor, reason: (attrs?.reason ?? "").trim() }
}

/** The line that the user sees in place of the tag. */
export function ackNotice(ack: ReflectionAck): string {
  const what = `skip the next ${ack.silenceFor} reflection checkpoint${ack.silenceFor === 1 ? "" : "s"}`
  const line = ack.reason ? `reflection ack: ${what} (${ack.reason})` : `reflection ack: ${what}`
  return `\x1b[2m${line}\x1b[22m\n`
}

/** The manifest inline-tag entry. */
export default async function reflectionAckHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") return { kind: "rendered", ansi: "" }
  if (pluginConfig(ctx.env).interval <= 0) return { kind: "rendered", ansi: "" }
  const ack = parseAck(ctx.trigger.attrs)
  if (!ack) return { kind: "rendered", ansi: "" }
  const state = stateFor(sessionKey(ctx.agent, ctx.env))
  state.silenceRemaining = ack.silenceFor
  state.ackSinceBatch = true
  ctx.log?.info("reflection ack", { silenceFor: ack.silenceFor, reason: ack.reason })
  return { kind: "rendered", ansi: ackNotice(ack) }
}
