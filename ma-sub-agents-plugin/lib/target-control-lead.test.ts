/** Tests for the lead side of the target control channel. */

import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  controlPathFor,
  ENV_TARGET_CONTROL_FILE,
  ENV_TARGET_CONTROL_KEY,
  readSwitchLines,
} from "@minimal-agent/core/plugin-api/utils/target-control"

import {
  appendControlLine,
  childControl,
  childControlOrNone,
  resetLeadControlForTests,
  writeSwitchLines,
} from "./target-control-lead.ts"
import type { SubagentRecord } from "./types.ts"

const LEAD = "ba0ad20f-1111-4111-8111-111111111111"
const FROM = { credentialName: "full", providerId: "p1", model: "m1", effort: "high" }
const TO = { credentialName: "second", providerId: "p2", model: "m2" }

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-target-control-"))
  resetLeadControlForTests()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetLeadControlForTests()
})

function record(sid: string, kind: "running" | "done", controlKeyId?: string): SubagentRecord {
  return {
    sid,
    status: kind === "running" ? { kind, pid: 1, startedAt: "t", progress: {} } : { kind },
    ...(controlKeyId !== undefined ? { controlKeyId } : {}),
  } as unknown as SubagentRecord
}

const opts = () => ({
  sessionsDir: dir,
  leadSid: LEAD,
  now: () => new Date("2026-11-17T12:00:00Z"),
})
const fileOf = (sid: string): string => readFileSync(controlPathFor(dir, sid), "utf8")

describe("childControl", () => {
  it("gives each worker its own key and the file path, with one key id for the lead process", () => {
    const a = childControl(dir, "child-a")
    const b = childControl(dir, "child-b")
    expect(a.env[ENV_TARGET_CONTROL_FILE]).toBe(controlPathFor(dir, "child-a"))
    expect(a.env[ENV_TARGET_CONTROL_KEY]).toMatch(/^[0-9a-f]{64}$/)
    expect(a.env[ENV_TARGET_CONTROL_KEY]).not.toBe(b.env[ENV_TARGET_CONTROL_KEY])
    expect(a.keyId).toBe(b.keyId)
    // The same worker gets the same key again in this process.
    expect(childControl(dir, "child-a").env[ENV_TARGET_CONTROL_KEY]).toBe(
      a.env[ENV_TARGET_CONTROL_KEY],
    )
  })
})

describe("childControlOrNone", () => {
  it("a bad worker id gives no control channel and one diagnostic, with no throw", () => {
    const warnings: string[] = []
    expect(childControlOrNone(dir, "../escape", (m) => warnings.push(m))).toBeNull()
    expect(warnings).toEqual([
      "sub-agent starts with no target control channel: target control: the worker id is not a plain id",
    ])
    expect(childControlOrNone(dir, "child-a", (m) => warnings.push(m))?.keyId).toMatch(
      /^[0-9a-f]{16}$/,
    )
    expect(warnings).toHaveLength(1)
  })
})

describe("writeSwitchLines", () => {
  it("each running worker gets one line that only its own key accepts", () => {
    const a = childControl(dir, "child-a")
    const b = childControl(dir, "child-b")
    const records = [
      record("child-a", "running", a.keyId),
      record("child-b", "running", b.keyId),
      record("child-done", "done", a.keyId),
    ]
    expect(writeSwitchLines(records, { from: FROM, to: TO }, opts())).toEqual({
      sent: 2,
      unreachable: 0,
      failed: 0,
    })

    const keyA = a.env[ENV_TARGET_CONTROL_KEY] ?? ""
    const keyB = b.env[ENV_TARGET_CONTROL_KEY] ?? ""
    const own = readSwitchLines(fileOf("child-a"), { key: keyA, lead: LEAD, afterSeq: 0 })
    expect(own.rejects).toEqual([])
    expect(own.lines).toHaveLength(1)
    expect(own.lines[0]).toMatchObject({ lead: LEAD, from: FROM, to: TO })
    // Worker b cannot use the line of worker a.
    expect(
      readSwitchLines(fileOf("child-a"), { key: keyB, lead: LEAD, afterSeq: 0 }).rejects,
    ).toEqual(["bad_mac"])
    // A worker that ended gets no file.
    expect(() => fileOf("child-done")).toThrow()
    // The file has no key and no secret.
    expect(fileOf("child-a")).not.toContain(keyA)
  })

  it("a second switch has a higher seq in the same file", () => {
    const a = childControl(dir, "child-a")
    const records = [record("child-a", "running", a.keyId)]
    writeSwitchLines(records, { from: FROM, to: TO }, opts())
    writeSwitchLines(records, { from: TO, to: FROM }, opts())
    const result = readSwitchLines(fileOf("child-a"), {
      key: a.env[ENV_TARGET_CONTROL_KEY] ?? "",
      lead: LEAD,
      afterSeq: 0,
    })
    expect(result.lines.map((l) => l.seq)).toEqual([1, 2])
  })

  it("the file is made with mode 0600", () => {
    const a = childControl(dir, "child-a")
    writeSwitchLines([record("child-a", "running", a.keyId)], { from: FROM, to: TO }, opts())
    expect(statSync(controlPathFor(dir, "child-a")).mode & 0o777).toBe(0o600)
  })

  it("after a lead restart, the workers of the old process are counted and get no line", () => {
    const old = childControl(dir, "child-old")
    resetLeadControlForTests() // the lead process restarted: a new secret
    const fresh = childControl(dir, "child-new")
    const records = [
      record("child-old", "running", old.keyId),
      record("child-legacy", "running"), // spawned by an older build: no key id
      record("child-new", "running", fresh.keyId),
    ]
    expect(writeSwitchLines(records, { from: FROM, to: TO }, opts())).toEqual({
      sent: 1,
      unreachable: 2,
      failed: 0,
    })
    expect(() => fileOf("child-old")).toThrow()
    expect(() => fileOf("child-legacy")).toThrow()
  })

  it("a symlink at the control path is refused, and its target is not written", () => {
    const a = childControl(dir, "child-a")
    const victim = join(dir, "victim.txt")
    writeFileSync(victim, "keep\n")
    symlinkSync(victim, controlPathFor(dir, "child-a"))
    expect(
      writeSwitchLines([record("child-a", "running", a.keyId)], { from: FROM, to: TO }, opts()),
    ).toEqual({ sent: 0, unreachable: 0, failed: 1 })
    expect(readFileSync(victim, "utf8")).toBe("keep\n")
  })
})

describe("appendControlLine", () => {
  it("appends and does not cut the file", () => {
    const path = join(dir, "x.control.jsonl")
    appendControlLine(path, "one")
    appendControlLine(path, "two")
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n")
  })

  it("refuses a directory at the path", () => {
    expect(() => appendControlLine(dir, "x")).toThrow()
  })
})
