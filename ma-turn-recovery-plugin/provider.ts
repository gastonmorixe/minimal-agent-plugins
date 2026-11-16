/**
 * Synthetic text provider for turn recovery: continue nudges, the assistant
 * placeholder, runtime turn markers, the tool results core makes on a
 * failure, a stop, an abort or a denial, and the user media markers.
 *
 * Each text is built from its facts only (plugin-api types/synthetic-text.ts).
 * The bytes equal the old core texts (tests/text-parity/fixtures/synthetic.json).
 * Long texts live in `prompts/*.md`, loaded by text import and filled by
 * {@link fill}. An unknown kind or a missing required fact throws.
 *
 * @module ma-turn-recovery-plugin/provider
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

import outputTruncatedMd from "./prompts/output-truncated.md" with { type: "text" }
import reflectionCheckpointMd from "./prompts/reflection-checkpoint.tmpl.md" with { type: "text" }
import placeholderMd from "./prompts/response-truncated-placeholder.md" with { type: "text" }
import sessionResumedMd from "./prompts/session-resumed.md" with { type: "text" }
import streamInterruptedMd from "./prompts/stream-interrupted.md" with { type: "text" }
import streamInterruptedContinueMd from "./prompts/stream-interrupted-continue.md" with {
  type: "text",
}
import turnAbortedMd from "./prompts/turn-aborted.md" with { type: "text" }

/** Every kind this provider owns. The manifest lists the same set. */
export const KINDS: readonly SyntheticKind[] = [
  "continue.max_tokens",
  "continue.stream_interrupted",
  "assistant.placeholder",
  "runtime.turn_aborted",
  "runtime.session_resumed",
  "runtime.stream_interrupted",
  "runtime.reflection_checkpoint",
  "runtime.reflection_ack_result",
  "tool_result.aborted",
  "tool_result.interrupted_by_stop",
  "tool_result.unknown_tool",
  "tool_result.handler_error",
  "tool_result.no_executor",
  "tool_result.subprocess_overflow",
  "tool_result.lock_timeout",
  "tool_result.lock_failed",
  "tool_result.policy_denied",
  "user_media.rejected",
  "user_media.unavailable",
]

/** Matches `%%name%%`, the placeholder of the `.tmpl.md` files. */
const PLACEHOLDER_RE = /%%([A-Za-z0-9_.-]+)%%/g

/**
 * Fill `%%name%%` placeholders from `vars` and trim the result (the old core
 * renderer trimmed too). A placeholder with no value throws.
 */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
  const out = template.replace(PLACEHOLDER_RE, (_full, name: string) => {
    const v = vars[name]
    if (v === undefined) throw new Error(`template is missing variable ${name}`)
    return String(v)
  })
  return out.trim()
}

/**
 * Human byte size: `900B`, `12KB`, `5.0MB`, `1.2GB`. Byte copy of
 * `formatBytes` in minimal-agent-core/src/media/types.ts (note N1).
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/** The model name in a media text when the facts carry no `modelId` (note N2). */
const NO_MODEL_LABEL = "this model"

const INTERRUPTED_BY_STOP =
  "The process stopped while this tool call ran. It may have run fully, partly, or not at all. Check its effects before you run it again."
const ABORTED_ORPHAN = "Tool execution aborted by user before completion."
const ABORTED_RUNTIME = "tool aborted by user"
const POLICY_DENIED_TOOL_WILL_INVOKE = "Tool blocked by lifecycle policy hook."
const REFLECTION_ACK_RESULT =
  "reflection-ack applied. Next time, write this tag as inline text in your response body, not as a tool call."
const MODE_NO_EXECUTOR =
  "Mode tool reached the dispatcher. The agent loop should have handled it. File a bug : see the `Mode` interceptor in `src/loops/tool-round.ts`."

/** A required string fact. Throws when absent or not a string. */
function str(kind: SyntheticKind, facts: SyntheticFacts, key: string): string {
  const v = facts[key]
  if (typeof v !== "string") throw new Error(`${kind}: ${key} must be a string`)
  return v
}

/** A required number fact. Throws when absent or not a number. */
function num(kind: SyntheticKind, facts: SyntheticFacts, key: string): number {
  const v = facts[key]
  if (typeof v !== "number") throw new Error(`${kind}: ${key} must be a number`)
  return v
}

/** The marker word of a media kind (core media/types.ts kindToken, lowercased). */
function kindWord(kind: string): string {
  switch (kind) {
    case "image":
      return "image"
    case "audio":
      return "audio"
    case "video":
      return "video"
    case "document":
      return "file"
    default:
      throw new Error(`user_media.rejected: unknown media kind ${kind}`)
  }
}

/** The bare rejection reason of `user_media.rejected`, from its facts. */
function rejectionReason(facts: SyntheticFacts): string {
  const k: SyntheticKind = "user_media.rejected"
  const model = typeof facts.modelId === "string" ? facts.modelId : NO_MODEL_LABEL
  const reason = str(k, facts, "reason")
  switch (reason) {
    case "unsupported-modality":
      return `${model} doesn't accept ${str(k, facts, "kind")} input`
    case "unsupported-type":
      return `${str(k, facts, "mimeType")} isn't a supported type for ${model}`
    case "too-large": {
      const raw = formatBytes(num(k, facts, "sizeBytes"))
      const enc = formatBytes(num(k, facts, "encodedBytes"))
      const lim = formatBytes(num(k, facts, "limitBytes"))
      return `${raw} (${enc} encoded) exceeds the ${lim} limit for ${model}`
    }
    case "dimensions": {
      const w = num(k, facts, "width")
      const h = num(k, facts, "height")
      return `${w}x${h} exceeds the ${num(k, facts, "maxDimension")}px limit for ${model}`
    }
    case "too-many":
      return `more than ${num(k, facts, "maxItems")} attachments for ${model}`
    case "request-too-large":
      return `attachments total exceeds the ${formatBytes(num(k, facts, "limitBytes"))} request limit for ${model}`
    default:
      throw new Error(`user_media.rejected: unknown reason ${reason}`)
  }
}

/** `user_media.rejected`: the bare reason (`site: check`) or the whole marker (`site: marker`). */
function mediaRejected(facts: SyntheticFacts): string {
  const site = facts.site
  if (site === "check") return rejectionReason(facts)
  if (site === "marker") {
    const word = kindWord(str("user_media.rejected", facts, "kind"))
    return `[${word} not sent: ${rejectionReason(facts)}]`
  }
  throw new Error(`user_media.rejected: unknown site ${String(site)}`)
}

/** The text of one owned kind. Throws on a kind it does not own. */
function render(kind: SyntheticKind, facts: SyntheticFacts): string {
  switch (kind) {
    case "continue.max_tokens":
      return fill(outputTruncatedMd)
    case "continue.stream_interrupted":
      return fill(streamInterruptedContinueMd)
    case "assistant.placeholder":
      return fill(placeholderMd)
    case "runtime.turn_aborted":
      return fill(turnAbortedMd)
    case "runtime.session_resumed":
      return fill(sessionResumedMd)
    case "runtime.stream_interrupted":
      return fill(streamInterruptedMd)
    case "runtime.reflection_checkpoint":
      return fill(reflectionCheckpointMd, {
        round: num(kind, facts, "round"),
        cooldownSec: num(kind, facts, "cooldownSec"),
      })
    case "runtime.reflection_ack_result":
      return REFLECTION_ACK_RESULT
    case "tool_result.aborted": {
      if (facts.site === "orphan") return ABORTED_ORPHAN
      if (facts.site === "runtime") return ABORTED_RUNTIME
      throw new Error(`aborted: unknown site ${String(facts.site)}`)
    }
    case "tool_result.interrupted_by_stop":
      return INTERRUPTED_BY_STOP
    case "tool_result.unknown_tool": {
      const name = str(kind, facts, "name")
      return facts.plugin === true ? `Unknown plugin tool: ${name}` : `Unknown tool: ${name}`
    }
    case "tool_result.handler_error":
      return `Handler error: ${str(kind, facts, "detail")}`
    case "tool_result.no_executor": {
      const name = str(kind, facts, "name")
      if (name === "Mode") return MODE_NO_EXECUTOR
      throw new Error(`no_executor: unknown tool ${name}`)
    }
    case "tool_result.subprocess_overflow": {
      const maxBytes = num(kind, facts, "maxBytes")
      const detail = str(kind, facts, "detail")
      return `Error: Subprocess output exceeded maximum length of ${maxBytes} bytes. Details: ${detail}`
    }
    case "tool_result.lock_timeout":
      return `${str(kind, facts, "tool")} error: ${str(kind, facts, "detail")}`
    case "tool_result.lock_failed":
      return `${str(kind, facts, "tool")} error: lock acquire failed: ${str(kind, facts, "detail")}`
    case "tool_result.policy_denied": {
      if (facts.hook === "tool.willInvoke") return POLICY_DENIED_TOOL_WILL_INVOKE
      throw new Error(`policy_denied: unknown hook ${String(facts.hook)}`)
    }
    case "user_media.rejected":
      return mediaRejected(facts)
    case "user_media.unavailable":
      return `[attachment #${str(kind, facts, "id")} unavailable]`
    default:
      throw new Error(`turn-recovery does not own kind ${kind}`)
  }
}

/** Create the provider. It throws on a kind it does not own or a missing fact. */
export function createTurnRecoveryProvider(): SyntheticTextProvider {
  return {
    kinds: KINDS,
    text: render,
  }
}
