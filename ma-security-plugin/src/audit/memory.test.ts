import { describe, expect, test } from "bun:test"

import { type AuditIO, createAuditLog } from "./index.ts"

const root = "memory-audit"
const sessionFile = "session.jsonl"
const filename = `${sessionFile}.security-audit.jsonl`
const event = { ruleId: "pii.email", decision: "redact", profile: "steer" } as const

function memoryIO() {
  const files = new Map<string, string>()
  const calls = { append: 0, rename: 0, remove: 0, read: 0 }
  const failures = { append: false, remove: false }
  const io: AuditIO = {
    append(base, name, data) {
      expect(base).toBe(root)
      calls.append++
      if (failures.append) return { error: "write failed" }
      files.set(name, (files.get(name) ?? "") + data)
      return { ok: true }
    },
    rename(base, from, to) {
      expect(base).toBe(root)
      calls.rename++
      const text = files.get(from)
      if (text === undefined) return { error: "missing" }
      files.set(to, text)
      files.delete(from)
      return { ok: true }
    },
    remove(base, name) {
      expect(base).toBe(root)
      calls.remove++
      if (failures.remove) return { error: "write failed" }
      if (!files.delete(name)) return { error: "missing" }
      return { ok: true }
    },
    read(base, name, cap) {
      expect(base).toBe(root)
      calls.read++
      const text = files.get(name)
      if (text === undefined) return { error: "missing" }
      if (Buffer.byteLength(text) > cap) return { error: "too big" }
      return { ok: true, value: { text, uid: 0, mode: 0o600 } }
    },
  }
  return { files, calls, failures, io }
}

function makeLog(memory: ReturnType<typeof memoryIO>, options = {}) {
  return createAuditLog({ root, sessionFile, now: () => 1, io: memory.io, ...options })
}

describe("in-memory audit log", () => {
  test("aggregates redactions by rule in stable order", () => {
    const memory = memoryIO()
    const log = makeLog(memory)
    expect(
      log.recordRedactions(
        [
          { ruleId: "pii.email", count: 2 },
          { ruleId: "pii.card" },
          { ruleId: "pii.email", count: 3 },
        ],
        "steer",
      ),
    ).toBe(true)
    expect(memory.calls.append).toBe(2)
    expect(log.readRecent().map(({ ruleId, count }) => ({ ruleId, count }))).toEqual([
      { ruleId: "pii.card", count: 1 },
      { ruleId: "pii.email", count: 5 },
    ])
    expect(log.snapshot().countsByRule).toEqual({ "pii.card": 1, "pii.email": 5 })
    expect(log.snapshot().countsByDecision.redact).toBe(6)
  })

  test("keep zero removes old rows without retaining archives", () => {
    const memory = memoryIO()
    const log = makeLog(memory, { maxMb: 0.0002, keep: 0 })
    for (let count = 1; count <= 5; count++) expect(log.record({ ...event, count })).toBe(true)
    expect([...memory.files.keys()]).toEqual([filename])
    expect(log.snapshot().rotations).toBe(4)
    expect(log.readRecent().map((row) => row.count)).toEqual([5])
    expect(memory.calls.rename).toBe(0)
  })

  test("keep two retains exactly the two newest archives", () => {
    const memory = memoryIO()
    const log = makeLog(memory, { maxMb: 0.0002, keep: 2 })
    for (let count = 1; count <= 5; count++) expect(log.record({ ...event, count })).toBe(true)
    expect([...memory.files.keys()].sort()).toEqual([filename, `${filename}.1`, `${filename}.2`])
    for (const [name, count] of [
      [filename, 5],
      [`${filename}.1`, 4],
      [`${filename}.2`, 3],
    ] as const) {
      expect(JSON.parse(memory.files.get(name) ?? "").count).toBe(count)
      expect(Buffer.byteLength(memory.files.get(name) ?? "")).toBeLessThanOrEqual(209)
    }
    expect(log.snapshot().rotations).toBe(4)
  })

  test("rotates an oversized startup file before appending", () => {
    const memory = memoryIO()
    const oversized = "x".repeat(2000)
    memory.files.set(filename, oversized)
    const log = makeLog(memory, { maxMb: 0.0004, keep: 2 })
    expect(memory.files.get(`${filename}.1`)).toBe(oversized)
    expect(memory.files.has(filename)).toBe(false)
    expect(log.snapshot()).toMatchObject({ rotations: 1, bytes: 0, degraded: false })
    expect(log.record(event)).toBe(true)
    expect(log.readRecent()).toHaveLength(2)
    expect(log.readRecent()[0]?.note).toBe("oversized-archive-kept")
    for (let i = 0; i < 10; i++) expect(log.record(event)).toBe(true)
    expect([...memory.files.values()]).not.toContain(oversized)
    expect(log.snapshot().bytes).toBe(Buffer.byteLength(memory.files.get(filename) ?? ""))
  })

  test("session counters survive two rotations", () => {
    const memory = memoryIO()
    const log = makeLog(memory, { maxMb: 0.0002, keep: 2 })
    for (const count of [2, 3, 4]) expect(log.record({ ...event, count })).toBe(true)
    expect(log.snapshot()).toMatchObject({
      rotations: 2,
      countsByRule: { "pii.email": 9 },
      countsByDecision: { redact: 9 },
      writeFailures: 0,
      auditWriteErrors: 0,
    })
    expect(log.readRecent().map((row) => row.count)).toEqual([4])
  })

  test("never outputs sentinel event fields", () => {
    const memory = memoryIO()
    const log = makeLog(memory)
    const sentinel = "SENTINEL_PRIVATE_EVENT_91"
    const privateEvent = {
      ruleId: sentinel,
      profile: sentinel,
      decision: sentinel,
      tool: sentinel,
      count: sentinel,
      tier: sentinel,
      note: sentinel,
      time: sentinel,
      kind: sentinel,
      value: sentinel,
      tag: sentinel,
      path: sentinel,
    }
    expect(log.record(privateEvent)).toBe(true)
    const output = JSON.stringify([log.snapshot(), log.readRecent(), [...memory.files.values()]])
    expect(output).not.toContain(sentinel)
    expect(log.readRecent()[0]).toMatchObject({
      time: 1,
      kind: "security",
      ruleId: "unknown-rule",
      decision: "note",
      count: 0,
      tier: "none",
    })
  })

  test("ignores a partial final line and repairs the next append boundary", () => {
    const memory = memoryIO()
    const original = makeLog(memory)
    expect(original.record(event)).toBe(true)
    const complete = memory.files.get(filename) ?? ""
    const partial = '{"unfinished":'
    memory.files.set(filename, complete + partial)
    const resumed = makeLog(memory)
    expect(resumed.readRecent()).toHaveLength(1)
    expect(resumed.record({ ...event, ruleId: "pii.card" })).toBe(true)
    expect(memory.files.get(filename)).toStartWith(complete + partial + "\n")
    expect(resumed.readRecent().map((row) => row.ruleId)).toEqual(["pii.email", "pii.card"])
    expect(resumed.snapshot().bytes).toBe(Buffer.byteLength(memory.files.get(filename) ?? ""))
  })

  test("retries startup rotation failure only at row 100 and recovers", () => {
    const memory = memoryIO()
    const oversized = "x".repeat(2000)
    memory.files.set(filename, oversized)
    memory.failures.remove = true
    const log = makeLog(memory, { maxMb: 0.0004, keep: 1 })
    expect(log.snapshot()).toMatchObject({ degraded: true, auditWriteErrors: 1, rotations: 0 })
    for (let row = 1; row < 100; row++) expect(log.record(event)).toBe(false)
    expect(memory.calls.remove).toBe(1)
    expect(memory.calls.append).toBe(0)
    expect(log.record(event)).toBe(false)
    expect(memory.calls.remove).toBe(2)
    expect(log.snapshot().auditWriteErrors).toBe(2)
    memory.failures.remove = false
    for (let row = 1; row < 100; row++) expect(log.record(event)).toBe(false)
    expect(memory.calls.remove).toBe(2)
    expect(log.record(event)).toBe(true)
    expect(memory.calls.remove).toBe(3)
    expect(memory.files.get(`${filename}.1`)).toBe(oversized)
    expect(log.snapshot()).toMatchObject({
      degraded: false,
      errorReason: "none",
      rotations: 1,
      auditWriteErrors: 2,
      countsByRule: { "pii.email": 200 },
      countsByDecision: { redact: 200 },
    })
    expect(log.readRecent()).toHaveLength(2)
    expect(log.readRecent()[0]?.note).toBe("oversized-archive-kept")
  })

  test("retries append failure at row 100 and preserves all counters", () => {
    const memory = memoryIO()
    const log = makeLog(memory)
    memory.failures.append = true
    expect(log.record(event)).toBe(false)
    expect(log.snapshot()).toMatchObject({
      degraded: true,
      errorReason: "audit-io-error",
      auditWriteErrors: 1,
    })
    memory.failures.append = false
    for (let row = 1; row < 100; row++) expect(log.record(event)).toBe(false)
    expect(memory.calls.append).toBe(1)
    expect(memory.calls.read).toBe(1)
    expect(log.record(event)).toBe(true)
    expect(memory.calls.append).toBe(2)
    expect(memory.calls.read).toBe(2)
    expect(log.snapshot()).toMatchObject({
      degraded: false,
      errorReason: "none",
      writeFailures: 1,
      auditWriteErrors: 1,
      countsByRule: { "pii.email": 101 },
      countsByDecision: { redact: 101 },
    })
    expect(log.readRecent()).toHaveLength(1)
  })

  test("records disabled builtins as config-drop with a fixed reason", () => {
    const memory = memoryIO()
    const log = makeLog(memory)
    expect(
      log.recordDisabledRules(
        [{ id: "pii.email", reason: "marker-safety", builtin: true }],
        "steer",
      ),
    ).toBe(true)
    expect(log.readRecent()).toEqual([
      {
        time: 1,
        kind: "security",
        ruleId: "pii.email",
        profile: "steer",
        decision: "config-drop",
        tool: "unknown",
        count: 1,
        tier: "none",
        note: "marker-safety",
      },
    ])
    expect(log.snapshot().countsByDecision["config-drop"]).toBe(1)
    expect(memory.files.get(filename)).not.toContain("builtin")
  })
})
