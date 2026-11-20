/**
 * Synthetic text provider for turn recovery: continue nudges, the assistant
 * placeholder, runtime turn markers, the tool results core makes on a
 * failure, a stop, an abort or a denial, the user media markers, and the
 * context compaction text (the summary system prompt and the checkpoint prose
 * after core's `<ma::context::compaction />` tag line).
 *
 * Each text is built from its facts only (plugin-api types/synthetic-text.ts).
 * The texts are the STE rewrite (P4) of the old core texts
 * (tests/text-parity/fixtures/synthetic.json). provider.parity.test.ts maps each old text to the new one.
 * Long texts live in `prompts/*.md`, loaded by text import and filled by
 * {@link fill}. An unknown kind or a missing required fact throws.
 *
 * The `compact.*` texts are a byte-equal move of the old core text
 * (tests/text-parity/fixtures/compact.json, core context-compact.ts), not
 * STE-rewritten yet. provider.compact.parity.test.ts pins the bytes.
 *
 * @module ma-turn-recovery-plugin/provider
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

import compactLocalStubMd from "./prompts/compact-local-stub.md" with { type: "text" }
import compactSummarySystemMd from "./prompts/compact-summary-system.md" with { type: "text" }
import compactTailCheckpointMd from "./prompts/compact-tail-checkpoint.tmpl.md" with {
  type: "text",
}
import outputTruncatedMd from "./prompts/output-truncated.md" with { type: "text" }
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
  "tool_result.aborted",
  "tool_result.interrupted_by_stop",
  "tool_result.unknown_tool",
  "tool_result.handler_error",
  "tool_result.no_executor",
  "tool_result.subprocess_overflow",
  "tool_result.lock_timeout",
  "tool_result.lock_failed",
  "tool_result.policy_denied",
  "tool_result.canceled",
  "tool_result.policy_hook_failed",
  "tool_result.policy_rewrite_note",
  "tool_result.non_tool_result",
  "tool_result.invalid_input",
  "runtime.hook_denied",
  "user_media.rejected",
  "user_media.unavailable",
  "compact.summary_system",
  "compact.tail_checkpoint",
  "compact.local_checkpoint",
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
  "The process stopped while this tool call ran. The tool call possibly ran to the end, stopped before the end, or did not start. Examine its effects before you run it again."
const ABORTED_ORPHAN = "The user stopped this tool call before it finished."
const ABORTED_RUNTIME = "tool aborted by user"
const POLICY_DENIED_TOOL_WILL_INVOKE = "A lifecycle policy hook prevented this tool call."
const CANCELED_SUBPROCESS = "The plugin tool call was stopped."
const SESSION_NO_EXECUTOR = "this session has no tool executor"
const HOOK_DENIED_TURN_WILL_STOP = "The turn.willStop hook did not let the turn stop."
const MODE_NO_EXECUTOR =
  "The Mode tool call reached the dispatcher. The agent loop must handle this tool call first. Report a bug. Refer to the `Mode` interceptor in `src/loops/tool-round.ts`."

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
      return `${model} does not accept ${str(k, facts, "kind")} input`
    case "unsupported-type":
      return `${str(k, facts, "mimeType")} is not a supported type for ${model}`
    case "too-large": {
      const raw = formatBytes(num(k, facts, "sizeBytes"))
      const enc = formatBytes(num(k, facts, "encodedBytes"))
      const lim = formatBytes(num(k, facts, "limitBytes"))
      return `${raw} (${enc} encoded) is more than the ${lim} limit for ${model}`
    }
    case "dimensions": {
      const w = num(k, facts, "width")
      const h = num(k, facts, "height")
      return `${w}x${h} is more than the ${num(k, facts, "maxDimension")}px limit for ${model}`
    }
    case "too-many":
      return `more than ${num(k, facts, "maxItems")} attachments for ${model}`
    case "request-too-large":
      return `the total size of the attachments is more than the ${formatBytes(num(k, facts, "limitBytes"))} request limit for ${model}`
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

/** An optional string fact: absent or "" gives undefined. A non-string throws. */
function optStr(kind: SyntheticKind, facts: SyntheticFacts, key: string): string | undefined {
  const v = facts[key]
  if (v === undefined || v === "") return undefined
  if (typeof v !== "string") throw new Error(`${kind}: ${key} must be a string`)
  return v
}

/** `compact.summary_system`: the summary request system prompt, plus the focus line. */
function compactSummarySystem(facts: SyntheticFacts): string {
  const base = fill(compactSummarySystemMd)
  const focus = optStr("compact.summary_system", facts, "focus")
  return focus === undefined ? base : `${base}\n\nFocus for this compaction (verbatim): ${focus}`
}

/** `compact.local_checkpoint`: the checkpoint prose after the tag line. */
function compactLocalCheckpoint(facts: SyntheticFacts): string {
  const k: SyntheticKind = "compact.local_checkpoint"
  const focus = optStr(k, facts, "focus")
  const summary = optStr(k, facts, "summary") ?? fill(compactLocalStubMd)
  const focusLine = focus === undefined ? "" : `\nFocus (verbatim): ${focus}\n`
  return `## Context checkpoint\n${focusLine}\n${summary}`
}

/** One schema error `i` of the flat indexed facts (`path.i`, `rule.i`, ...). */
function schemaError(kind: SyntheticKind, facts: SyntheticFacts, i: number): string {
  const path = str(kind, facts, `path.${i}`)
  const at = path === "" ? "(root)" : path
  const rule = str(kind, facts, `rule.${i}`)
  switch (rule) {
    case "enum":
      return `${at}: value does not match any enum constant`
    case "type": {
      const expected = str(kind, facts, `expected.${i}`).split(",").join(" | ")
      return `${at}: expected type ${expected}, got ${str(kind, facts, `got.${i}`)}`
    }
    case "required":
      return `${at}: missing required property "${str(kind, facts, `key.${i}`)}"`
    case "additional":
      return `${at}: additional property "${str(kind, facts, `key.${i}`)}" is not allowed`
    default:
      throw new Error(`${kind}: unknown rule ${rule}`)
  }
}

/** The schema error list of `tool_result.invalid_input`: `count` errors joined with `. `. */
function schemaErrors(kind: SyntheticKind, facts: SyntheticFacts): string {
  const count = num(kind, facts, "count")
  if (!Number.isInteger(count) || count < 1) throw new Error(`${kind}: count must be >= 1`)
  return Array.from({ length: count }, (_, i) => schemaError(kind, facts, i)).join(". ")
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
      if (facts.site === "session") return SESSION_NO_EXECUTOR
      if (name === "Mode") return MODE_NO_EXECUTOR
      throw new Error(`no_executor: unknown tool ${name}`)
    }
    case "tool_result.subprocess_overflow": {
      const maxBytes = num(kind, facts, "maxBytes")
      const detail = str(kind, facts, "detail")
      return `Error: The subprocess output was more than the maximum length of ${maxBytes} bytes. Details: ${detail}`
    }
    case "tool_result.lock_timeout":
      return `${str(kind, facts, "tool")} error: ${str(kind, facts, "detail")}`
    case "tool_result.lock_failed":
      return `${str(kind, facts, "tool")} error: cannot get the lock: ${str(kind, facts, "detail")}`
    case "tool_result.policy_denied": {
      if (facts.hook === "tool.willInvoke") return POLICY_DENIED_TOOL_WILL_INVOKE
      throw new Error(`policy_denied: unknown hook ${String(facts.hook)}`)
    }
    case "tool_result.policy_hook_failed": {
      if (facts.hook !== "tool.willInvoke") {
        throw new Error(`policy_hook_failed: unknown hook ${String(facts.hook)}`)
      }
      const detail = str(kind, facts, "detail")
      // A failing listener with a label (the HookBus result), else the emit threw.
      if (typeof facts.label === "string") {
        return `Denied: approval hook "${facts.label}" failed (${detail}).`
      }
      return `${POLICY_DENIED_TOOL_WILL_INVOKE} The approval hook failed (${detail}).`
    }
    case "tool_result.policy_rewrite_note": {
      const keys = str(kind, facts, "keys")
      const dropped = num(kind, facts, "dropped")
      const shown = keys === "" ? [] : [keys]
      const list = dropped > 0 ? [...shown, `+${dropped} more`].join(", ") : keys
      return `the policy changed the input: ${list}`
    }
    case "tool_result.non_tool_result":
      return `Plugin tool "${str(kind, facts, "tool")}" returned a non-tool_result value`
    case "tool_result.invalid_input":
      return `${str(kind, facts, "tool")} error: ${schemaErrors(kind, facts)}`
    case "tool_result.canceled": {
      if (facts.site === "subprocess") return CANCELED_SUBPROCESS
      throw new Error(`canceled: unknown site ${String(facts.site)}`)
    }
    case "runtime.hook_denied": {
      if (facts.hook === "turn.willStop") return HOOK_DENIED_TURN_WILL_STOP
      throw new Error(`hook_denied: unknown hook ${String(facts.hook)}`)
    }
    case "user_media.rejected":
      return mediaRejected(facts)
    case "user_media.unavailable":
      return `[attachment #${str(kind, facts, "id")} is not available]`
    case "compact.summary_system":
      return compactSummarySystem(facts)
    case "compact.tail_checkpoint":
      return fill(compactTailCheckpointMd, { retained: num(kind, facts, "retained") })
    case "compact.local_checkpoint":
      return compactLocalCheckpoint(facts)
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
