/**
 * ACP `stopReason` for a finished `session/prompt` turn. This is the ACP
 * refinement (design doc section 4a, spec v3 section 7) on top of core's
 * coarse, shared {@link deriveStopCause}:
 *
 * | outcome   | last turn_completed.stopReason   | ACP result |
 * |-----------|----------------------------------|------------|
 * | completed | end_turn, stop_sequence, tool_use, null | end_turn |
 * | completed | refusal, content_filter          | refusal |
 * | completed | pause_turn                       | end_turn + notice + `_meta` |
 * | completed | context_window_exceeded          | max_tokens + notice "context window full" + `_meta` (lossy) |
 * | completed | error                            | end_turn + notice + `_meta` |
 * | truncated | (none) + max_tokens_capped        | max_tokens |
 * | truncated | (none) + stream_interrupted_capped | end_turn + `_meta` reason (core's own notice is already sent) |
 * | aborted   | any                              | cancelled (never a JSON-RPC error) |
 * | failed    | -                                | JSON-RPC error, error text sent first |
 * | waiting   | -                                | JSON-RPC error, error text sent first |
 *
 * `max_turn_requests` is never sent: core has no round cap
 * (`stop-policy.ts`). `_meta` keys are prefixed with `minimal-agent/`
 * (spec v3 section 3: a client may ignore them).
 *
 * @module stop-reason
 */

import type { TurnCompletedEvent } from "@minimal-agent/core/sdk/events"
import { deriveStopCause } from "@minimal-agent/core/sdk/events"
import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

import type { AcpNotice } from "./notices.ts"
import { RPC_ERROR } from "./transport.ts"

/** The ACP stop reasons this plugin can send. `max_turn_requests` is left out on purpose. */
export type AcpStopReason = "end_turn" | "max_tokens" | "refusal" | "cancelled"

/** Provider stop reason, as `turn_completed` carries it. */
export type ProviderStopReason = TurnCompletedEvent["stopReason"]

/** `_meta` key for the original provider stop reason. */
export const META_STOP_REASON = "minimal-agent/stopReason"
/** `_meta` key for a core truncation reason (`interrupted_text`). */
export const META_REASON = "minimal-agent/reason"

/** What the turn encoder collected during one turn. */
export interface StopInputs {
  readonly outcome: "completed" | "truncated" | "failed" | "aborted" | "waiting"
  /**
   * `stopReason` of the LAST `turn_completed` in this turn. `undefined`
   * when none was emitted (a truncated turn emits none).
   */
  readonly lastStopReason?: ProviderStopReason | undefined
  /** The last notice of a stop-relevant kind (refusal, content_filter, *_capped). */
  readonly lastNotice?: TurnNotice | null
  /** The last `error` event of the turn. */
  readonly lastError?: { readonly message: string; readonly code?: string } | null
}

/** The prompt reply, or a JSON-RPC error. `notice` is sent BEFORE the reply or error. */
export type StopDecision =
  | {
      readonly kind: "reply"
      readonly stopReason: AcpStopReason
      readonly meta?: Readonly<Record<string, string>>
      readonly notice?: AcpNotice
    }
  | {
      readonly kind: "error"
      readonly code: number
      readonly message: string
      readonly notice: AcpNotice
    }

/** Decide the ACP stop reason for a finished turn. Pure. */
export function decideStopReason(inputs: StopInputs): StopDecision {
  const { outcome } = inputs
  if (outcome === "completed" && inputs.lastStopReason !== undefined) {
    return fromProviderStopReason(inputs.lastStopReason)
  }
  const cause = deriveStopCause({
    outcome,
    lastNotice: inputs.lastNotice ?? null,
    lastError: inputs.lastError ?? null,
  })
  switch (cause.kind) {
    case "completed":
      return { kind: "reply", stopReason: "end_turn" }
    case "refused":
      return { kind: "reply", stopReason: "refusal" }
    case "truncated":
      return cause.reason === "max_tokens"
        ? { kind: "reply", stopReason: "max_tokens" }
        : { kind: "reply", stopReason: "end_turn", meta: { [META_REASON]: "interrupted_text" } }
    case "aborted":
      return { kind: "reply", stopReason: "cancelled" }
    case "failed":
      return {
        kind: "error",
        code: RPC_ERROR.internal,
        message: cause.message,
        notice: { severity: "error", title: "Turn failed", description: cause.message },
      }
    case "waiting": {
      const message = inputs.lastError?.message ?? "the run paused after a permanent error"
      return {
        kind: "error",
        code: RPC_ERROR.internal,
        message,
        notice: { severity: "error", title: "Run paused after an error", description: message },
      }
    }
    default: {
      const _exhaustive: never = cause
      throw new Error(`unhandled stop cause: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

function fromProviderStopReason(reason: ProviderStopReason): StopDecision {
  switch (reason) {
    case "refusal":
    case "content_filter":
      // Core already sent its own StopNotice for these; no extra notice.
      return { kind: "reply", stopReason: "refusal" }
    case "pause_turn":
      return {
        kind: "reply",
        stopReason: "end_turn",
        meta: { [META_STOP_REASON]: reason },
        notice: {
          severity: "warning",
          title: "Turn paused by the provider",
          description: "The provider paused the turn. Send another prompt to go on.",
        },
      }
    case "context_window_exceeded":
      return {
        kind: "reply",
        stopReason: "max_tokens",
        meta: { [META_STOP_REASON]: reason },
        notice: {
          severity: "warning",
          title: "Context window full",
          description:
            "The conversation no longer fits in the model's context window. " +
            "ACP has no stop reason for this, so it is reported as max_tokens.",
        },
      }
    case "error":
      return {
        kind: "reply",
        stopReason: "end_turn",
        meta: { [META_STOP_REASON]: reason },
        notice: {
          severity: "warning",
          title: "Provider reported an error",
          description: "The provider ended the turn with an error stop reason.",
        },
      }
    case "max_tokens":
      // Rows 3-4 of the stop table never settle as completed; kept honest if it ever does.
      return { kind: "reply", stopReason: "max_tokens" }
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
    case null:
      return { kind: "reply", stopReason: "end_turn" }
    default: {
      const _exhaustive: never = reason
      throw new Error(`unhandled provider stop reason: ${String(_exhaustive)}`)
    }
  }
}
