/**
 * Fixture tests for Cursor usage decode + CanonicalUsage mapping.
 * Schemas from cursor-agent 2026.07.23-e383d2b (Cheryl RE + bundle extract).
 */

import { describe, expect, test } from "bun:test"

import { connectFrameProto } from "./connect/stream.ts"
import {
  applyCursorUsageEvent,
  type CursorUsageState,
  cursorUsageReceipts,
  cursorUsageToCanonical,
} from "./cursor-usage.ts"
import {
  decodeCheckpointTokenDetails,
  decodeConversationTokenDetails,
  extractServerTextEvents,
} from "./proto/agent-run.ts"
import { concat, encMsg, encString, encVarintField } from "./proto/wire.ts"
import { translateCursorStreamBuffer } from "./response-stream.ts"
import { CursorBidiEnvelopeTranslator } from "./response-stream-bidi.ts"

/** AgentServerMessage.interaction_update(#1) wrapping an InteractionUpdate oneof body. */
function encInteractionUpdate(
  oneofField: number,
  body: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return encMsg(1, encMsg(oneofField, body))
}

function encTokenDelta(tokens: number): Uint8Array {
  return encInteractionUpdate(8, encVarintField(1, tokens))
}

function encSummary(text: string): Uint8Array {
  return encInteractionUpdate(9, encString(1, text))
}

function encSummaryStarted(): Uint8Array {
  return encInteractionUpdate(10)
}

function encSummaryCompleted(hookMessage?: string): Uint8Array {
  return encInteractionUpdate(11, hookMessage ? encString(1, hookMessage) : new Uint8Array(0))
}

function encCheckpointTokenDetails(used: number, max: number): Uint8Array {
  // ASM #3 ConversationStateStructure with token_details #5
  const tokenDetails = concat(encVarintField(1, used), encVarintField(2, max))
  return encMsg(3, encMsg(5, tokenDetails))
}

function encTextAndTurn(text: string): Uint8Array {
  return concat(encInteractionUpdate(1, encString(1, text)), encInteractionUpdate(14))
}

describe("ConversationTokenDetails decode", () => {
  test("used_tokens #1 and max_tokens #2", () => {
    const body = concat(encVarintField(1, 12_345), encVarintField(2, 1_000_000))
    expect(decodeConversationTokenDetails(body)).toEqual({
      usedTokens: 12_345,
      maxTokens: 1_000_000,
    })
  })

  test("partial fields stay undefined", () => {
    expect(decodeConversationTokenDetails(encVarintField(1, 9))).toEqual({
      usedTokens: 9,
      maxTokens: undefined,
    })
  })
})

describe("extractServerTextEvents usage/summary kinds", () => {
  test("token_delta (#8) yields tokens, not fabricated output", () => {
    const events = extractServerTextEvents(encTokenDelta(777))
    expect(events).toEqual([{ kind: "token_delta", rawField: 8, tokens: 777 }])
  })

  test("checkpoint token_details wins path decode", () => {
    const events = extractServerTextEvents(encCheckpointTokenDetails(42_000, 200_000))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: "conversation_checkpoint_update",
      rawField: 3,
      usedTokens: 42_000,
      maxTokens: 200_000,
    })
    expect(
      decodeCheckpointTokenDetails(encMsg(5, concat(encVarintField(1, 1), encVarintField(2, 2)))),
    ).toEqual({
      usedTokens: 1,
      maxTokens: 2,
    })
  })

  test("summary lifecycle names: summary_started / summary / summary_completed", () => {
    const kinds = [
      ...extractServerTextEvents(encSummaryStarted()),
      ...extractServerTextEvents(encSummary("compacted history")),
      ...extractServerTextEvents(encSummaryCompleted("hook note")),
    ].map((e) => e.kind)
    expect(kinds).toEqual(["summary_started", "summary", "summary_completed"])
    const completed = extractServerTextEvents(encSummaryCompleted("hook note"))[0]!
    expect(completed.hookMessage).toBe("hook note")
  })

  test("interaction_query (#7) stays opaque (not PreCompact)", () => {
    const events = extractServerTextEvents(encMsg(7, new Uint8Array([0x08, 0x01])))
    expect(events).toEqual([{ kind: "interaction_query", rawField: 7 }])
  })
})

describe("cursorUsageToCanonical mapping", () => {
  test("checkpoint used_tokens wins over token_delta", () => {
    const state: CursorUsageState = {}
    applyCursorUsageEvent(state, { kind: "token_delta", tokens: 100 })
    applyCursorUsageEvent(state, {
      kind: "conversation_checkpoint_update",
      usedTokens: 9_000,
      maxTokens: 100_000,
    })
    expect(cursorUsageToCanonical(state)).toEqual({ inputTokens: 9_000, outputTokens: 0 })
    expect(cursorUsageReceipts(state)).toMatchObject({
      cursorUsedTokens: 9_000,
      cursorMaxTokens: 100_000,
      cursorTokenDeltaTokens: 100,
    })
  })

  test("token_delta alone is inputTokens fallback; never outputTokens", () => {
    const state: CursorUsageState = {}
    applyCursorUsageEvent(state, { kind: "token_delta", tokens: 55 })
    const usage = cursorUsageToCanonical(state)
    expect(usage.inputTokens).toBe(55)
    expect(usage.outputTokens).toBe(0)
  })

  test("zero/partial: empty state stays zeros", () => {
    expect(cursorUsageToCanonical({})).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(cursorUsageReceipts({})).toBeUndefined()
  })
})

describe("translateCursorStream usage", () => {
  test("message_delta carries checkpoint usage + receipts; outputTokens stays 0", async () => {
    const payload = concat(
      encTokenDelta(111),
      encCheckpointTokenDetails(222, 333_000),
      encSummaryStarted(),
      encSummary("sum"),
      encSummaryCompleted("done"),
      encTextAndTurn("hi"),
    )
    const framed = connectFrameProto(payload)
    const events = []
    for await (const ev of translateCursorStreamBuffer(framed, { modelId: "composer-2.5-fast" })) {
      events.push(ev)
    }
    const delta = events.find((e) => e.type === "message_delta")
    expect(delta?.type).toBe("message_delta")
    if (delta?.type !== "message_delta") return
    expect(delta.usage).toEqual({ inputTokens: 222, outputTokens: 0 })
    expect(delta.receipts).toMatchObject({
      cursorUsedTokens: 222,
      cursorMaxTokens: 333_000,
      cursorTokenDeltaTokens: 111,
      cursorSummaryStarted: true,
      cursorSummary: "sum",
      cursorSummaryCompletedHook: "done",
    })
  })

  test("token_delta-only stream does not fabricate output token count", async () => {
    const payload = concat(encTokenDelta(88), encTextAndTurn("ok"))
    const framed = connectFrameProto(payload)
    const events = []
    for await (const ev of translateCursorStreamBuffer(framed, { modelId: "composer-2.5-fast" })) {
      events.push(ev)
    }
    const delta = events.find((e) => e.type === "message_delta")
    if (delta?.type !== "message_delta") throw new Error("missing message_delta")
    expect(delta.usage.inputTokens).toBe(88)
    expect(delta.usage.outputTokens).toBe(0)
  })
})

describe("bidi translator usage", () => {
  test("same checkpoint-wins mapping on bidi path", () => {
    const t = new CursorBidiEnvelopeTranslator({ modelId: "composer-2.5-fast" })
    const payload = concat(
      encTokenDelta(10),
      encCheckpointTokenDetails(99, 1000),
      encTextAndTurn("x"),
    )
    const { events } = t.push({
      flags: 0,
      compressed: false,
      endStream: false,
      payload,
      rawPayload: payload,
    })
    const delta = events.find((e) => e.type === "message_delta")
    if (delta?.type !== "message_delta") throw new Error("missing message_delta")
    expect(delta.usage).toEqual({ inputTokens: 99, outputTokens: 0 })
    expect(delta.receipts?.cursorMaxTokens).toBe(1000)
  })
})
