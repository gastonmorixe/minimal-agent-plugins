/**
 * `CompactContext` tool handler: validate input, check the host compact
 * sub-API, queue the request, return `queued: true` + a human message.
 *
 * The plugin never compacts directly (no `agent.compact()` call). The host
 * performs the history rewrite after the turn; this handler only queues.
 * Missing capability (`context:compact` not granted) is a loud error, not
 * a crash. A host that refused the queue (`queued: false`) is also an
 * error, with the args echoed so the model can retry or tell the user.
 *
 * @module compact/handlers/compact-context
 */

import { DEFAULT_KEEP_TAIL, validateCompactInput } from "../lib/args.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"

/** Tool handler for `CompactContext`: queue a compaction, report back. */
export default async function compactContext(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return {
      kind: "tool_result",
      content: "CompactContext: wrong trigger type",
      is_error: true,
    }
  }

  const v = validateCompactInput(ctx.trigger.input)
  if (!v.ok) {
    return { kind: "tool_result", content: `CompactContext: ${v.error}`, is_error: true }
  }
  const { mode, keepTail, focus, reason } = v.value

  const compact = ctx.host?.compact
  if (!compact) {
    return {
      kind: "tool_result",
      content:
        "CompactContext: compaction unavailable: the plugin is missing the 'context:compact' capability",
      is_error: true,
    }
  }

  try {
    const result = await compact.requestCompact({
      reason,
      ...(mode !== undefined ? { mode } : {}),
      ...(keepTail !== undefined ? { keepTail } : {}),
      ...(focus !== undefined ? { focus } : {}),
    })
    if (!result.queued) {
      return {
        kind: "tool_result",
        content: "CompactContext: host refused the compaction request (queued: false).",
        is_error: true,
      }
    }
    return {
      kind: "tool_result",
      content: formatQueued({ mode, keepTail, focus, reason }),
      displayHeader: `compact queued (${mode ?? "local"})`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { kind: "tool_result", content: `CompactContext: ${msg}`, is_error: true }
  }
}

/** Human message confirming the queued compaction and its parameters. */
function formatQueued(opts: {
  mode?: string
  keepTail?: number
  focus?: string
  reason: string
}): string {
  const mode = opts.mode ?? "local"
  const keepTail = opts.keepTail ?? DEFAULT_KEEP_TAIL
  const parts = [`Compact queued (mode: ${mode}, tail: ${keepTail}, reason: ${opts.reason}).`]
  if (opts.focus) parts.push(`Focus: ${opts.focus}`)
  parts.push("The host rewrites history after this turn. Continue with the retained tail.")
  return parts.join(" ")
}
