/**
 * Plain description text for each core {@link TurnNotice}. The plugin owns
 * this text. `notices.test.ts` pins every string, so a change here is a
 * visible diff. The exhaustive `switch` makes a new kind a compile error.
 *
 * @module notice-text
 */

import type { NoticeTarget, TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

/** One value of the target that a switch changed. */
export interface TargetChangeText {
  /** `credential`, `provider`, `model` or `effort`. */
  readonly label: string
  /** The new value, as text. */
  readonly to: string
  /** The value before, as text. */
  readonly from: string
}

/** What the text says for a value that is not set. */
const UNSET: Readonly<Record<string, string>> = {
  credential: "the provider default",
  provider: "none",
  effort: "the model default",
}

/**
 * The values that a target switch changed, in the order of the chain:
 * credential, provider, model, effort. Empty when the notice has no targets
 * (an automatic model adoption, or a core that does not send them).
 */
export function targetChanges(notice: {
  readonly fromTarget?: NoticeTarget
  readonly toTarget?: NoticeTarget
}): TargetChangeText[] {
  const { fromTarget: from, toTarget: to } = notice
  if (!from || !to) return []
  const rows: [string, string | undefined, string | undefined][] = [
    ["credential", from.credentialName, to.credentialName],
    ["provider", from.providerId, to.providerId],
    ["model", from.model, to.model],
    ["effort", from.effort, to.effort],
  ]
  const text = (label: string, value: string | undefined): string =>
    value === undefined ? (UNSET[label] ?? "none") : `"${value}"`
  return rows
    .filter(([, a, b]) => a !== b)
    .map(([label, a, b]) => ({ label, from: text(label, a), to: text(label, b) }))
}

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
      // A target switch: name each value that changed (the model can be the same).
      const changed = targetChanges(notice)
      if (changed.length > 0) {
        const list = changed.map((c) => `${c.label} to ${c.to} (was ${c.from})`).join(", ")
        return `[target] Changed ${list}.`
      }
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
