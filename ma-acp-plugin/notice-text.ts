/**
 * Plain description text for each core {@link TurnNotice}. The plugin owns
 * this text. `notices.test.ts` pins every string, so a change here is a
 * visible diff. The exhaustive `switch` makes a new kind a compile error.
 *
 * @module notice-text
 */

import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

/** One-line, style-free description of a notice, for the ACP `description` field. */
export function noticeDescription(notice: TurnNotice): string {
  switch (notice.kind) {
    case "refusal":
    case "content_filter": {
      const label = notice.kind === "refusal" ? "refusal" : "content filter"
      const category = notice.category ? ` (${notice.category})` : ""
      const message = notice.message ? ` \u2014 ${notice.message}` : ""
      return `[${label}] The provider's safety layer ended the response${category}${message}. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.`
    }
    case "max_tokens_salvaged":
      return "[max_tokens] Response hit the max_tokens ceiling mid tool-call; salvaged the in-flight call and continuing."
    case "max_tokens_continuing":
      return `[max_tokens] Response hit the max_tokens ceiling; auto-continuing (${notice.attempt}/${notice.cap}).`
    case "max_tokens_capped":
      return `[max_tokens] Response hit the max_tokens ceiling ${notice.cap} times in a row; stopping. Consider narrowing the request or raising max_tokens.`
    case "reflection_ack": {
      const suffix = notice.reason.length > 0 ? ` \u2014 ${notice.reason}` : ""
      const via = notice.fromToolFallback ? " (from tool_use fallback)" : ""
      return `reflection ack: silencing next ${notice.silenceFor} checkpoint${notice.silenceFor === 1 ? "" : "s"}${suffix}${via}`
    }
    case "stream_interrupted_salvaged": {
      const n = notice.completedToolCalls
      return `[stream] Provider closed the response without a terminal event after ${n} complete tool call${n === 1 ? "" : "s"}; salvaged closed tools, discarded partials, and continuing from local state. Do not repeat those tool calls.`
    }
    case "stream_interrupted_continuing":
      return `[stream] Provider closed the response without a terminal event mid-output; auto-continuing from local state (${notice.attempt}/${notice.cap}).`
    case "stream_interrupted_capped":
      return `[stream] Provider closed the response without a terminal event ${notice.cap} times in a row mid-output; stopping. Partial output above is preserved.`
    case "ask_denied":
      return `[ask] No host can answer "${notice.title}" (${notice.code}) in this run; denied the ask and sent the request unchanged.`
    case "model_adopted": {
      const effort = notice.effortReset ? ` (effort reset from "${notice.effortFrom}")` : ""
      return `[model] Adopted model "${notice.to}" (was "${notice.from}")${effort}.`
    }
    case "model_adopt_failed":
      return `[model] Could not adopt model "${notice.requested}" (${notice.reason}); kept "${notice.model}".`
    case "stop_hook_capped":
      return `[stop hook] A turn.willStop hook blocked the stop more than ${notice.cap} times in a row; ended the turn.`
    default: {
      const _exhaustive: never = notice
      throw new Error(`unknown notice kind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
