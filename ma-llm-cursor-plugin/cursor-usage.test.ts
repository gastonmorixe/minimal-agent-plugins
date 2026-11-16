/**
 * Fixture tests for Cursor usage decode + CanonicalUsage mapping.
 * Schemas from cursor-agent 2026.07.23-e383d2b (Cheryl RE + bundle extract).
 */

import { describe, expect, test } from "bun:test"

import { connectFrameProto } from "./connect/stream.ts"
import {
  applyCursorUsageEvent,
  clearCursorLastMaxTokens,
  type CursorUsageState,
  cursorUsageReceipts,
  cursorUsageToCanonical,
  getCursorContextWindowForStatus,
  getCursorLastMaxTokens,
} from "./cursor-usage.ts"
import {
  decodeCheckpointTokenDetails,
  decodeConversationTokenDetails,
  decodeWireTokenUsage,
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

/** TurnEndedUpdate with CLI-style wire totals (input INCLUDES cache). */
function encTurnEndedUsage(opts: {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}): Uint8Array {
  const parts = [
    encVarintField(1, opts.input),
    encVarintField(2, opts.output),
  ]
  if (opts.cacheRead != null) parts.push(encVarintField(3, opts.cacheRead))
  if (opts.cacheWrite != null) parts.push(encVarintField(4, opts.cacheWrite))
  if (opts.reasoning != null) parts.push(encVarintField(5, opts.reasoning))
  return encInteractionUpdate(14, concat(...parts))
}

/** ModelCallCompletedUpdate (#31): model_call_id#1 + tokens #2–#6. */
function encModelCallCompleted(opts: {
  modelCallId: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}): Uint8Array {
  const parts = [
    encString(1, opts.modelCallId),
    encVarintField(2, opts.input),
    encVarintField(3, opts.output),
  ]
  if (opts.cacheRead != null) parts.push(encVarintField(4, opts.cacheRead))
  if (opts.cacheWrite != null) parts.push(encVarintField(5, opts.cacheWrite))
  return encInteractionUpdate(31, concat(...parts))
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

describe("getCursorContextWindowForStatus", () => {
  test("returns max_tokens when used is below max", () => {
    clearCursorLastMaxTokens()
    applyCursorUsageEvent(
      {},
      { kind: "conversation_checkpoint_update", usedTokens: 50_000, maxTokens: 200_000 },
    )
    expect(getCursorContextWindowForStatus()).toBe(200_000)
  })

  test("returns used_tokens when used exceeds max", () => {
    clearCursorLastMaxTokens()
    applyCursorUsageEvent(
      {},
      { kind: "conversation_checkpoint_update", usedTokens: 143_400, maxTokens: 128_000 },
    )
    expect(getCursorContextWindowForStatus()).toBe(143_400)
  })
})

describe("TurnEnded / ModelCallCompleted wire usage", () => {
  test("decodeWireTokenUsage TurnEnded fields", () => {
    const body = concat(
      encVarintField(1, 1000),
      encVarintField(2, 40),
      encVarintField(3, 700),
      encVarintField(4, 50),
      encVarintField(5, 12),
    )
    expect(decodeWireTokenUsage(body)).toEqual({
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheWriteTokens: 50,
      reasoningTokens: 12,
      modelCallId: undefined,
    })
  })

  test("extractServerTextEvents decodes turn_ended token body", () => {
    const events = extractServerTextEvents(
      encTurnEndedUsage({ input: 1000, output: 40, cacheRead: 700, cacheWrite: 50 }),
    )
    expect(events).toEqual([
      {
        kind: "turn_ended",
        rawField: 14,
        inputTokens: 1000,
        outputTokens: 40,
        cacheReadTokens: 700,
        cacheWriteTokens: 50,
        reasoningTokens: undefined,
        modelCallId: undefined,
      },
    ])
  })

  test("extractServerTextEvents decodes model_call_completed", () => {
    const events = extractServerTextEvents(
      encModelCallCompleted({
        modelCallId: "mc-1",
        input: 500,
        output: 10,
        cacheRead: 400,
      }),
    )
    expect(events[0]).toMatchObject({
      kind: "model_call_completed",
      rawField: 31,
      modelCallId: "mc-1",
      inputTokens: 500,
      outputTokens: 10,
      cacheReadTokens: 400,
    })
  })

  test("CLI $() mapping: uncached = input - cacheRead - cacheWrite", () => {
    clearCursorLastMaxTokens()
    const state: CursorUsageState = {}
    applyCursorUsageEvent(state, {
      kind: "turn_ended",
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheWriteTokens: 50,
    })
    expect(cursorUsageToCanonical(state)).toEqual({
      inputTokens: 250,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheCreationTokens: 50,
    })
  })

  test("latest model_call_completed replaces prior call (no sum)", () => {
    const state: CursorUsageState = {}
    applyCursorUsageEvent(state, {
      kind: "model_call_completed",
      inputTokens: 100,
      outputTokens: 1,
      cacheReadTokens: 80,
    })
    applyCursorUsageEvent(state, {
      kind: "model_call_completed",
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheWriteTokens: 50,
    })
    expect(cursorUsageToCanonical(state)).toEqual({
      inputTokens: 250,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheCreationTokens: 50,
    })
  })

  test("turn_ended with tokens wins over checkpoint for CanonicalUsage", () => {
    clearCursorLastMaxTokens()
    const state: CursorUsageState = {}
    applyCursorUsageEvent(state, {
      kind: "conversation_checkpoint_update",
      usedTokens: 9000,
      maxTokens: 200_000,
    })
    applyCursorUsageEvent(state, {
      kind: "turn_ended",
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadTokens: 700,
    })
    expect(cursorUsageToCanonical(state)).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 700,
    })
    expect(getCursorLastMaxTokens()).toBe(200_000)
    expect(cursorUsageReceipts(state)).toMatchObject({
      cursorUsedTokens: 9000,
      cursorMaxTokens: 200_000,
      cursorWireInputTokens: 1000,
      cursorWireCacheReadTokens: 700,
    })
  })

  test("empty turn_ended keeps checkpoint fallback", () => {
    const state: CursorUsageState = {}
    applyCursorUsageEvent(state, {
      kind: "conversation_checkpoint_update",
      usedTokens: 42,
      maxTokens: 128_000,
    })
    applyCursorUsageEvent(state, { kind: "turn_ended" })
    expect(cursorUsageToCanonical(state)).toEqual({ inputTokens: 42, outputTokens: 0 })
  })
})

describe("translateCursorStream turn-ended usage with cache", () => {
  test("message_delta reports disjoint cache fields", async () => {
    clearCursorLastMaxTokens()
    const payload = concat(
      encCheckpointTokenDetails(900, 200_000),
      encInteractionUpdate(1, encString(1, "hi")),
      encTurnEndedUsage({ input: 1000, output: 40, cacheRead: 700, cacheWrite: 50 }),
    )
    const framed = connectFrameProto(payload)
    const events = []
    for await (const ev of translateCursorStreamBuffer(framed, { modelId: "cursor-auto" })) {
      events.push(ev)
    }
    const delta = events.find((e) => e.type === "message_delta")
    if (delta?.type !== "message_delta") throw new Error("missing message_delta")
    expect(delta.usage).toEqual({
      inputTokens: 250,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheCreationTokens: 50,
    })
    expect(delta.receipts).toMatchObject({
      cursorUsedTokens: 900,
      cursorMaxTokens: 200_000,
      cursorWireCacheReadTokens: 700,
    })
    expect(getCursorLastMaxTokens()).toBe(200_000)
  })
})
