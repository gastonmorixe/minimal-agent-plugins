import { describe, expect, it } from "bun:test"

import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

import {
  decideStopReason,
  META_REASON,
  META_STOP_REASON,
  type ProviderStopReason,
  type StopInputs,
} from "./stop-reason.ts"

const refusal: TurnNotice = { kind: "refusal", severity: "error", category: null, message: "no" }
const maxCapped: TurnNotice = { kind: "max_tokens_capped", severity: "warn", cap: 5 }
const interrupted: TurnNotice = { kind: "stream_interrupted_capped", severity: "warn", cap: 1 }

describe("ACP stop reason (design doc 4a)", () => {
  it.each<[ProviderStopReason]>([["end_turn"], ["stop_sequence"], ["tool_use"], [null]])(
    "completed + %p -> end_turn, no notice",
    (reason) => {
      expect(decideStopReason({ outcome: "completed", lastStopReason: reason })).toEqual({
        kind: "reply",
        stopReason: "end_turn",
      })
    },
  )

  it.each<[ProviderStopReason]>([["refusal"], ["content_filter"]])(
    "completed + %p -> refusal",
    (reason) => {
      const d = decideStopReason({
        outcome: "completed",
        lastStopReason: reason,
        lastNotice: refusal,
      })
      expect(d).toEqual({ kind: "reply", stopReason: "refusal" })
    },
  )

  it("uses the LAST turn_completed stop reason, not an earlier refusal notice", () => {
    const d = decideStopReason({
      outcome: "completed",
      lastStopReason: "end_turn",
      lastNotice: refusal,
    })
    expect(d).toMatchObject({ stopReason: "end_turn" })
  })

  it("completed with no turn_completed falls back to the notice (refusal)", () => {
    expect(decideStopReason({ outcome: "completed", lastNotice: refusal })).toMatchObject({
      stopReason: "refusal",
    })
    expect(decideStopReason({ outcome: "completed" })).toMatchObject({ stopReason: "end_turn" })
  })

  it("completed + pause_turn -> end_turn plus notice plus _meta", () => {
    const d = decideStopReason({ outcome: "completed", lastStopReason: "pause_turn" })
    expect(d).toMatchObject({
      kind: "reply",
      stopReason: "end_turn",
      meta: { [META_STOP_REASON]: "pause_turn" },
    })
    expect(d.notice?.title.length).toBeGreaterThan(0)
  })

  it("completed + context_window_exceeded -> max_tokens plus 'context window full' notice, never 'output limit'", () => {
    const d = decideStopReason({ outcome: "completed", lastStopReason: "context_window_exceeded" })
    expect(d).toMatchObject({
      kind: "reply",
      stopReason: "max_tokens",
      meta: { [META_STOP_REASON]: "context_window_exceeded" },
    })
    expect(d.notice?.title).toBe("Context window full")
    expect(`${d.notice?.title} ${d.notice?.description}`.toLowerCase()).not.toContain(
      "output limit",
    )
  })

  it("completed + error -> end_turn plus notice plus _meta", () => {
    const d = decideStopReason({ outcome: "completed", lastStopReason: "error" })
    expect(d).toMatchObject({
      kind: "reply",
      stopReason: "end_turn",
      meta: { [META_STOP_REASON]: "error" },
    })
    expect(d.notice).toBeDefined()
  })

  it("truncated + max_tokens_capped -> max_tokens", () => {
    expect(decideStopReason({ outcome: "truncated", lastNotice: maxCapped })).toEqual({
      kind: "reply",
      stopReason: "max_tokens",
    })
  })

  it("truncated + stream_interrupted_capped -> end_turn with _meta reason", () => {
    expect(decideStopReason({ outcome: "truncated", lastNotice: interrupted })).toEqual({
      kind: "reply",
      stopReason: "end_turn",
      meta: { [META_REASON]: "interrupted_text" },
    })
  })

  it("aborted -> cancelled, never an error", () => {
    expect(decideStopReason({ outcome: "aborted", lastStopReason: "end_turn" })).toEqual({
      kind: "reply",
      stopReason: "cancelled",
    })
  })

  it("failed -> JSON-RPC error with the error text as a notice first", () => {
    const d = decideStopReason({ outcome: "failed", lastError: { message: "boom" } })
    expect(d).toMatchObject({ kind: "error", code: -32603, message: "boom" })
    expect(d.notice?.description).toBe("boom")
  })

  it("waiting -> JSON-RPC error with the error text as a notice first", () => {
    const d = decideStopReason({ outcome: "waiting", lastError: { message: "auth expired" } })
    expect(d).toMatchObject({ kind: "error", message: "auth expired" })
    expect(d.notice?.severity).toBe("error")
  })

  it("never answers max_turn_requests", () => {
    const outcomes: StopInputs["outcome"][] = ["completed", "aborted", "failed", "waiting"]
    const reasons: (ProviderStopReason | undefined)[] = [
      undefined,
      null,
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "refusal",
      "pause_turn",
      "context_window_exceeded",
      "content_filter",
      "error",
    ]
    for (const outcome of outcomes) {
      for (const lastStopReason of reasons) {
        const d = decideStopReason({ outcome, lastStopReason })
        if (d.kind === "reply") expect(d.stopReason as string).not.toBe("max_turn_requests")
      }
    }
    for (const lastNotice of [maxCapped, interrupted]) {
      const d = decideStopReason({ outcome: "truncated", lastNotice })
      if (d.kind === "reply") expect(d.stopReason as string).not.toBe("max_turn_requests")
    }
  })
})
