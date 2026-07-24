/**
 * Regression: Cursor wire agent mode must default to AGENT (not ASK),
 * must not rewrite system text for mode, and must honor metadata override only.
 */
import { describe, expect, test } from "bun:test"

import { cursorCaps } from "./capabilities.ts"
import { AGENT_MODE } from "./proto/agent-run.ts"
import { decodeFields, fieldBytes } from "./proto/wire.ts"
import {
  buildCursorAgentRunBody,
  resolveCursorWireAgentMode,
  summarizeRequestText,
} from "./request-body.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const ZERO_PRICING = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
} as const

function baseModel() {
  return {
    id: "cursor-composer-2.5-fast",
    providerId: "cursor",
    surfaceId: CURSOR_SURFACE_AGENT_RUN,
    displayName: "Composer 2.5 Fast (Cursor)",
    capabilities: cursorCaps({ thinking: true }),
    pricing: ZERO_PRICING,
    tags: ["cursor", "live", "thinking", "effort-param:effort"],
    vendorIds: { cursor: "composer-2.5-fast", firstParty: "composer-2.5-fast" },
  }
}

/** UserMessage.mode is field 4 (varint) under conversation_action → user_message_action → user_message. */
function extractUserMessageMode(body: Uint8Array): number | undefined {
  // AgentClientMessage f1 = AgentRunRequest
  const outer = decodeFields(body)
  const run = fieldBytes(outer.find((f) => f.no === 1)!)
  if (!run) return undefined
  const runFields = decodeFields(run)
  // f2 = ConversationAction
  const convAction = fieldBytes(runFields.find((f) => f.no === 2)!)
  if (!convAction) return undefined
  const caFields = decodeFields(convAction)
  // f1 = UserMessageAction
  const uma = fieldBytes(caFields.find((f) => f.no === 1)!)
  if (!uma) return undefined
  const umaFields = decodeFields(uma)
  // f1 = UserMessage
  const um = fieldBytes(umaFields.find((f) => f.no === 1)!)
  if (!um) return undefined
  const umFields = decodeFields(um)
  const modeField = umFields.find((f) => f.no === 4 && f.wire === 0)
  return modeField ? Number(modeField.value) : undefined
}

describe("resolveCursorWireAgentMode", () => {
  test("defaults to AGENT when metadata absent", () => {
    expect(
      resolveCursorWireAgentMode({
        modelId: "x",
        messages: [],
      }),
    ).toBe(AGENT_MODE.AGENT)
  })

  test("maps cursor-agent-mode metadata without touching system", () => {
    expect(
      resolveCursorWireAgentMode({
        modelId: "x",
        messages: [],
        metadata: { custom: { "cursor-agent-mode": "ask" } },
      }),
    ).toBe(AGENT_MODE.ASK)
    expect(
      resolveCursorWireAgentMode({
        modelId: "x",
        messages: [],
        metadata: { custom: { "cursor-agent-mode": "PLAN" } },
      }),
    ).toBe(AGENT_MODE.PLAN)
    expect(
      resolveCursorWireAgentMode({
        modelId: "x",
        messages: [],
        metadata: { custom: { "cursor-agent-mode": "debug" } },
      }),
    ).toBe(AGENT_MODE.DEBUG)
    expect(
      resolveCursorWireAgentMode({
        modelId: "x",
        messages: [],
        metadata: { custom: { "cursor-agent-mode": "nope" } },
      }),
    ).toBe(AGENT_MODE.AGENT)
  })
})

describe("buildCursorAgentRunBody wire mode", () => {
  test("default body encodes UserMessage.mode = AGENT (1), not ASK (2)", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        system: [{ type: "text", text: "STABLE_SYSTEM_PREFIX" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      baseModel(),
    )
    expect(extractUserMessageMode(body)).toBe(AGENT_MODE.AGENT)
    expect(extractUserMessageMode(body)).not.toBe(AGENT_MODE.ASK)
  })

  test("metadata cursor-agent-mode=ask encodes ASK without changing system fold text", () => {
    const system = "STABLE_SYSTEM_PREFIX_FOR_CACHE"
    const reqAsk = {
      modelId: "cursor-composer-2.5-fast",
      system: [{ type: "text" as const, text: system }],
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      metadata: { custom: { "cursor-agent-mode": "ask" } },
    }
    const reqAgent = {
      modelId: "cursor-composer-2.5-fast",
      system: [{ type: "text" as const, text: system }],
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    }
    const bodyAsk = buildCursorAgentRunBody(reqAsk, baseModel())
    const bodyAgent = buildCursorAgentRunBody(reqAgent, baseModel())
    expect(extractUserMessageMode(bodyAsk)).toBe(AGENT_MODE.ASK)
    expect(extractUserMessageMode(bodyAgent)).toBe(AGENT_MODE.AGENT)
    // Cache safety: summarizeRequestText (system+messages fold) identical for mode override
    expect(summarizeRequestText(reqAsk)).toBe(summarizeRequestText(reqAgent))
    expect(summarizeRequestText(reqAsk)).toContain(system)
    expect(summarizeRequestText(reqAsk)).not.toMatch(/Ask mode is active/i)
  })

  test("system fold does not inject ask-mode policy text", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-composer-2.5-fast",
        system: [{ type: "text", text: "You are minimal-agent." }],
        messages: [{ role: "user", content: [{ type: "text", text: "list tools" }] }],
      },
      baseModel(),
    )
    // Flattened text lives in user message field 1
    const outer = decodeFields(body)
    const run = fieldBytes(outer.find((f) => f.no === 1)!)!
    const runFields = decodeFields(run)
    const convAction = fieldBytes(runFields.find((f) => f.no === 2)!)!
    const uma = fieldBytes(decodeFields(convAction).find((f) => f.no === 1)!)!
    const um = fieldBytes(decodeFields(uma).find((f) => f.no === 1)!)!
    const textField = decodeFields(um).find((f) => f.no === 1 && f.wire === 2)!
    const text = new TextDecoder().decode(fieldBytes(textField)!)
    expect(text).toContain("You are minimal-agent.")
    expect(text).toContain("list tools")
    expect(text).not.toMatch(/Ask mode is active/i)
    expect(text).not.toMatch(/system_reminder/i)
  })
})
