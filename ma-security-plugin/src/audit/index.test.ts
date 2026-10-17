import { lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { writeFileIn } from "../state/fs.ts"
import { makeFixtureDir, removeFixtureDir } from "../test-support.ts"

import { createAuditLog } from "./index.ts"

const dirs: string[] = []
function fixture(): string {
  const dir = makeFixtureDir("audit-")
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeFixtureDir(dir)
})

describe("bounded private audit log integration", () => {
  test("creates a private adjacent file and aggregates a send by rule", () => {
    const root = fixture()
    const log = createAuditLog({ root, sessionFile: "session.jsonl", now: () => 1000 })
    expect(
      log.recordRedactions(
        [
          { ruleId: "pii.email", count: 2 },
          { ruleId: "pii.email", count: 3 },
          { ruleId: "pii.card", count: 1 },
        ],
        "steer",
      ),
    ).toBe(true)
    const path = join(root, "session.jsonl.security-audit.jsonl")
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row))
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.ruleId === "pii.email").count).toBe(5)
    expect(log.snapshot().countsByRule["pii.email"]).toBe(5)
    expect(log.readRecent()).toHaveLength(2)
  })

  test("rotates by bytes, keeps the configured files and preserves totals", () => {
    const root = fixture()
    const log = createAuditLog({
      root,
      sessionFile: "session.jsonl",
      maxMb: 0.0004,
      keep: 2,
      now: () => 1,
    })
    for (let i = 0; i < 20; i++) {
      expect(
        log.record({ ruleId: "pii.email", decision: "redact", profile: "steer", count: 1 }),
      ).toBe(true)
    }
    const files = readdirSync(root).sort()
    expect(files).toHaveLength(3)
    expect(files.some((file) => file.endsWith(".2"))).toBe(true)
    expect(log.snapshot().countsByRule["pii.email"]).toBe(20)
    expect(log.snapshot().rotations).toBeGreaterThan(2)
    for (const file of files) expect(lstatSync(join(root, file)).mode & 0o777).toBe(0o600)
  })

  test("keep zero retains only the current file", () => {
    const root = fixture()
    const log = createAuditLog({ root, sessionFile: "session.jsonl", maxMb: 0.0004, keep: 0 })
    for (let i = 0; i < 8; i++)
      log.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })
    expect(readdirSync(root)).toHaveLength(1)
    expect(log.snapshot().countsByRule["pii.email"]).toBe(8)
  })

  test("drops secret fields and unknown ids from every row and snapshot", () => {
    const root = fixture()
    const sentinel = "SENTINEL_PRIVATE_PAYLOAD_91"
    const log = createAuditLog({ root, sessionFile: "session.jsonl", now: () => Number.NaN })
    log.record({
      ruleId: sentinel,
      profile: sentinel,
      decision: sentinel,
      kind: sentinel,
      tool: sentinel,
      note: sentinel,
      count: sentinel,
      tier: sentinel,
      value: sentinel,
      tag: sentinel,
      path: sentinel,
      time: sentinel,
    } as never)
    const output =
      JSON.stringify([log.snapshot(), log.readRecent()]) +
      readFileSync(join(root, "session.jsonl.security-audit.jsonl"), "utf8")
    expect(output).not.toContain(sentinel)
    expect(log.readRecent()[0]?.ruleId).toBe("unknown-rule")
  })

  test("reader ignores trailing partial rows and append repairs the row boundary", () => {
    const root = fixture()
    const filename = "session.jsonl.security-audit.jsonl"
    const log = createAuditLog({ root, sessionFile: "session.jsonl" })
    log.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })
    const original = readFileSync(join(root, filename), "utf8")
    expect(writeFileIn(root, filename, original + '{"unfinished":')).toEqual({ ok: true })
    const resumed = createAuditLog({ root, sessionFile: "session.jsonl" })
    expect(resumed.readRecent()).toHaveLength(1)
    expect(resumed.record({ ruleId: "pii.card", decision: "redact", profile: "guard" })).toBe(true)
    expect(resumed.readRecent()).toHaveLength(2)
  })

  test("rotates an oversized existing log before the next append", () => {
    const root = fixture()
    const filename = "session.jsonl.security-audit.jsonl"
    writeFileIn(root, filename, "x".repeat(2000))
    const log = createAuditLog({ root, sessionFile: "session.jsonl", maxMb: 0.0004, keep: 1 })
    expect(log.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })).toBe(true)
    expect(readFileSync(join(root, `${filename}.1`), "utf8")).toHaveLength(2000)
    expect(log.readRecent()).toHaveLength(2)
    expect(log.readRecent()[0]?.note).toBe("oversized-archive-kept")
  })

  test("retries failed rotation at most once per 100 rows and recovers", () => {
    const root = fixture()
    const outside = fixture()
    const filename = "session.jsonl.security-audit.jsonl"
    writeFileIn(root, filename, "x".repeat(2000))
    writeFileIn(outside, "safe", "untouched")
    symlinkSync(join(outside, "safe"), join(root, `${filename}.1`))
    const log = createAuditLog({ root, sessionFile: "session.jsonl", maxMb: 0.0004, keep: 1 })
    expect(log.snapshot().degraded).toBe(true)
    for (let i = 0; i < 99; i++)
      expect(log.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })).toBe(false)
    expect(log.snapshot().auditWriteErrors).toBe(1)
    unlinkSync(join(root, `${filename}.1`))
    expect(log.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })).toBe(true)
    expect(log.snapshot().degraded).toBe(false)
    expect(log.snapshot().countsByRule["pii.email"]).toBe(100)
    expect(readFileSync(join(outside, "safe"), "utf8")).toBe("untouched")
  })

  test("reader sanitizes tampered rows and ignores invalid JSON", () => {
    const root = fixture()
    const sentinel = "SENTINEL_TAMPERED_ROW_42"
    const filename = "session.jsonl.security-audit.jsonl"
    writeFileIn(
      root,
      filename,
      `${JSON.stringify({ time: 1, ruleId: sentinel, profile: sentinel, decision: sentinel, note: sentinel, tool: sentinel, count: 1 })}\nnot-json\n`,
    )
    const log = createAuditLog({ root, sessionFile: "session.jsonl" })
    expect(JSON.stringify(log.readRecent())).not.toContain(sentinel)
    expect(log.readRecent()).toHaveLength(1)
  })

  test("refuses escapes and symlink targets without exposing error details", () => {
    const root = fixture()
    const outside = fixture()
    writeFileIn(outside, "untouched", "safe")
    symlinkSync(join(outside, "untouched"), join(root, "session.jsonl.security-audit.jsonl"))
    const log = createAuditLog({ root, sessionFile: "session.jsonl" })
    expect(log.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })).toBe(false)
    expect(readFileSync(join(outside, "untouched"), "utf8")).toBe("safe")
    const escaped = createAuditLog({ root, sessionFile: "../outside.jsonl" })
    expect(escaped.record({ ruleId: "pii.email", decision: "redact", profile: "steer" })).toBe(
      false,
    )
    expect(JSON.stringify(escaped.snapshot())).not.toContain(root)
  })

  test("records a disabled built-in with only its id and fixed reason", () => {
    const root = fixture()
    const log = createAuditLog({ root, sessionFile: "session.jsonl" })
    expect(
      log.recordDisabledRules(
        [{ id: "pii.email", reason: "marker-safety", builtin: true }],
        "steer",
      ),
    ).toBe(true)
    expect(log.readRecent()[0]).toMatchObject({
      ruleId: "pii.email",
      decision: "config-drop",
      note: "marker-safety",
      count: 1,
    })
  })

  test("handles every decision and bounds status counters to known ids", () => {
    const root = fixture()
    const log = createAuditLog({ root, sessionFile: "session.jsonl" })
    const decisions = [
      "redact",
      "note",
      "autofix",
      "deny",
      "ask",
      "tier1",
      "tier2",
      "deadline",
      "config-drop",
      "tag-collision",
      "escalate",
    ] as const
    for (const decision of decisions)
      expect(log.record({ ruleId: "pii.email", decision, profile: "steer" })).toBe(true)
    for (let i = 0; i < 100; i++)
      log.record({ ruleId: `unknown-${i}`, decision: "note", profile: "steer" })
    expect(Object.keys(log.snapshot().countsByRule).sort()).toEqual(["pii.email", "unknown-rule"])
    for (const decision of decisions)
      expect(log.snapshot().countsByDecision[decision]).toBeGreaterThan(0)
    expect(log.readRecent(3)).toHaveLength(3)
  })
})
