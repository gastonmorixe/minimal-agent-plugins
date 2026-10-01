/**
 * Conversation carry: send Cursor's own checkpoint back instead of folding
 * the transcript into one user text.
 *
 * Regression 2026-10-01 (Debra d339b433): a fresh Run folded about 160 past
 * tool calls into a 500k-char user text, and cursor-auto replied with fake
 * call text instead of real calls (research/cursor-fake-toolcall-forensics.md).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

import { cursorCaps } from "./capabilities.ts"
import {
  type CursorCarryState,
  clearCursorCarryState,
  cursorCarryDir,
  cursorCarryEnabled,
  fingerprintMessages,
  getCursorCarryState,
  planCursorCarry,
  resetCursorCarryStatesForTests,
  setCursorCarryState,
} from "./conversation-carry.ts"
import type { CanonicalMessage } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelView } from "./lib/provider-plugin.ts"
import { extractCheckpointBytes } from "./proto/agent-run.ts"
import { concat, decodeFields, encMsg, fieldBytes, fieldString } from "./proto/wire.ts"
import { buildCursorAgentRunBody } from "./request-body.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const covered: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "Call VaultLookup." }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "call_1", name: "VaultLookup", input: { key: "main" } }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "call_1",
        content: [{ type: "text", text: "PURPLE-4217" }],
      },
    ],
  },
]
const reply: CanonicalMessage = { role: "assistant", content: [{ type: "text", text: "done" }] }
const next: CanonicalMessage = {
  role: "user",
  content: [{ type: "text", text: "now run all checks" }],
}

function stateFor(messages: CanonicalMessage[]): CursorCarryState {
  return {
    checkpoint: new Uint8Array([1, 2, 3]),
    blobs: new Map([["aa", new Uint8Array([9])]]),
    coveredCount: messages.length,
    fingerprint: fingerprintMessages(messages),
  }
}

describe("planCursorCarry", () => {
  test("covered prefix + assistant reply + new user text: carry with only the new text", () => {
    const plan = planCursorCarry(stateFor(covered), [...covered, reply, next])
    expect(plan?.userText).toBe("now run all checks")
  })

  test("covered prefix + new user text directly: carry", () => {
    expect(planCursorCarry(stateFor(covered), [...covered, next])?.userText).toBe(
      "now run all checks",
    )
  })

  test("no state: no carry", () => {
    expect(planCursorCarry(undefined, [...covered, next])).toBeUndefined()
  })

  test("edited history (fingerprint mismatch): no carry", () => {
    const edited = [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }]
    expect(
      planCursorCarry(stateFor(covered), [...edited, ...covered.slice(1), next]),
    ).toBeUndefined()
  })

  test("compacted (shorter) history: no carry", () => {
    expect(planCursorCarry(stateFor(covered), [next])).toBeUndefined()
  })

  test("tool blocks after the covered prefix: no carry (server state lacks them)", () => {
    const extra: CanonicalMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_2", name: "X", input: {} }],
    }
    expect(planCursorCarry(stateFor(covered), [...covered, extra, next])).toBeUndefined()
  })

  test("tool_result continuation: no carry", () => {
    expect(planCursorCarry(stateFor(covered.slice(0, 2)), covered)).toBeUndefined()
  })

  test("last message is assistant: no carry", () => {
    expect(planCursorCarry(stateFor(covered), [...covered, reply])).toBeUndefined()
  })

  test("two user turns after the prefix: no carry (the server missed one)", () => {
    expect(planCursorCarry(stateFor(covered), [...covered, next, reply, next])).toBeUndefined()
  })

  test("kill switch MA_CURSOR_CARRY=0", () => {
    expect(cursorCarryEnabled({})).toBe(true)
    expect(cursorCarryEnabled({ MA_CURSOR_CARRY: "0" })).toBe(false)
  })
})

describe("carry persistence", () => {
  let dir: string
  const prev = process.env.MA_CURSOR_CARRY_DIR
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cursor-carry-test-"))
    process.env.MA_CURSOR_CARRY_DIR = dir
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.MA_CURSOR_CARRY_DIR
    else process.env.MA_CURSOR_CARRY_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => resetCursorCarryStatesForTests())

  test("state survives a process restart (memory cleared, disk read back)", () => {
    setCursorCarryState("sid-1", stateFor(covered))
    resetCursorCarryStatesForTests()
    const back = getCursorCarryState("sid-1")
    expect(back?.coveredCount).toBe(3)
    expect([...(back?.checkpoint ?? [])]).toEqual([1, 2, 3])
    expect([...(back?.blobs.get("aa") ?? [])]).toEqual([9])
  })

  test("clear removes the file", () => {
    setCursorCarryState("sid-2", stateFor(covered))
    clearCursorCarryState("sid-2")
    resetCursorCarryStatesForTests()
    expect(getCursorCarryState("sid-2")).toBeUndefined()
    expect(readdirSync(dir).some((f) => f.startsWith("sid-2"))).toBe(false)
  })

  test("empty MA_CURSOR_CARRY_DIR disables persistence", () => {
    expect(cursorCarryDir({ MA_CURSOR_CARRY_DIR: "" })).toBeUndefined()
    expect(cursorCarryDir({ MINIMAL_AGENT_HOME: "/x" })).toBe("/x/cursor-carry")
  })
})

describe("extractCheckpointBytes", () => {
  test("reads AgentServerMessage #3 bytes and ignores other fields", () => {
    const payload = concat(encMsg(1, new Uint8Array([7])), encMsg(3, new Uint8Array([4, 5])))
    expect([...(extractCheckpointBytes(payload) ?? [])]).toEqual([4, 5])
    expect(extractCheckpointBytes(encMsg(1, new Uint8Array([7])))).toBeUndefined()
  })
})

const model: ModelView = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Auto (Cursor)",
  capabilities: cursorCaps(),
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  vendorIds: { cursor: "default" },
}

function runFields(body: Uint8Array) {
  return decodeFields(fieldBytes(decodeFields(body).find((f) => f.no === 1)!)!)
}

function userText(body: Uint8Array): string {
  const action = fieldBytes(runFields(body).find((f) => f.no === 2)!)!
  const uma = fieldBytes(decodeFields(action).find((f) => f.no === 1)!)!
  const um = fieldBytes(decodeFields(uma).find((f) => f.no === 1)!)!
  return fieldString(decodeFields(um).find((f) => f.no === 1)!) ?? ""
}

describe("buildCursorAgentRunBody with a carry plan", () => {
  const req: CanonicalRequest = {
    modelId: "cursor-auto",
    system: [{ type: "text", text: "SYSTEM RULES" }],
    messages: [...covered, reply, next],
  }

  test("sends the checkpoint as conversation_state and only the new user text", () => {
    const plan = planCursorCarry(stateFor(covered), req.messages)
    const body = buildCursorAgentRunBody(req, model, plan)
    const state = fieldBytes(runFields(body).find((f) => f.no === 1)!)
    expect([...(state ?? [])]).toEqual([1, 2, 3])
    expect(userText(body)).toBe("now run all checks")
    expect(userText(body)).not.toContain("SYSTEM RULES")
    expect(userText(body)).not.toContain("call_1")
  })

  test("without a plan: empty conversation_state and the full fold", () => {
    const body = buildCursorAgentRunBody(req, model)
    expect(fieldBytes(runFields(body).find((f) => f.no === 1)!)?.length).toBe(0)
    expect(userText(body)).toContain("SYSTEM RULES")
    expect(userText(body)).toContain("now run all checks")
  })
})
