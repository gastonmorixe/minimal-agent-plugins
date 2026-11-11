import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import dumpAndHalt, {
  HALT_REASON,
  isConversationSend,
  resolveTarget,
  type SendSnapshot,
  toDump,
} from "./dump_and_halt.ts"

const tools = [{ name: "Read", description: "read a file", input_schema: { type: "object" } }]

function snap(over: Partial<SendSnapshot> = {}): SendSnapshot {
  return {
    messages: [{ role: "user", content: "hello" }],
    system: [{ type: "text", text: "# Environment\ncwd=/x" }],
    model: "claude-test",
    providerId: "anthropic",
    request: { requestType: "conversation", tools, maxTokens: 64 },
    ...over,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-dry-run-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("dumpAndHalt", () => {
  test("conversation send: writes the full dump and halts", () => {
    const out = join(dir, "req.json")
    const res = dumpAndHalt(snap(), { env: { MINIMAL_AGENT_DRY_RUN_OUT: out } })
    expect(res).toEqual({ halt: true, reason: HALT_REASON })
    const doc = JSON.parse(readFileSync(out, "utf8"))
    expect(doc.dryRun).toBe(true)
    expect(doc.model).toBe("claude-test")
    expect(doc.providerId).toBe("anthropic")
    expect(doc.system[0].text).toContain("# Environment")
    expect(doc.messages).toEqual([{ role: "user", content: "hello" }])
    expect(doc.request.tools).toEqual(tools)
    expect(doc.request.maxTokens).toBe(64)
  })

  test("compact send: halts with no dump", () => {
    const out = join(dir, "req.json")
    const res = dumpAndHalt(snap({ compact: true }), { env: { MINIMAL_AGENT_DRY_RUN_OUT: out } })
    expect(res.halt).toBe(true)
    expect(() => readFileSync(out)).toThrow()
  })

  test("title send: halts with no dump", () => {
    const out = join(dir, "req.json")
    const res = dumpAndHalt(snap({ request: { requestType: "title" } }), {
      env: { MINIMAL_AGENT_DRY_RUN_OUT: out },
    })
    expect(res.halt).toBe(true)
    expect(() => readFileSync(out)).toThrow()
  })
})

describe("isConversationSend", () => {
  test("no request view counts as conversation (older core)", () => {
    expect(isConversationSend(snap({ request: undefined }))).toBe(true)
  })
  test("quota is not a conversation send", () => {
    expect(isConversationSend(snap({ request: { requestType: "quota" } }))).toBe(false)
  })
})

describe("resolveTarget", () => {
  test("unset, empty, and - go to stdout", () => {
    expect(resolveTarget(undefined)).toEqual({ kind: "fd", fd: 1 })
    expect(resolveTarget("")).toEqual({ kind: "fd", fd: 1 })
    expect(resolveTarget("-")).toEqual({ kind: "fd", fd: 1 })
  })
  test("stderr goes to fd 2", () => {
    expect(resolveTarget("stderr")).toEqual({ kind: "fd", fd: 2 })
  })
  test("any other value is a file path", () => {
    expect(resolveTarget("req.json")).toEqual({ kind: "file", path: "req.json" })
  })
})

describe("toDump", () => {
  test("missing request becomes null and missing providerId is omitted", () => {
    const d = toDump(snap({ request: undefined, providerId: undefined }))
    expect(d.request).toBeNull()
    expect("providerId" in d).toBe(false)
  })
})
