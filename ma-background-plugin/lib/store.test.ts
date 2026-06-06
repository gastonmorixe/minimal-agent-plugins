import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { BgJobStore, evictExcess, nextId, parseRecords, serializeRecords } from "./store.ts"
import { isActive, type JobRecord, type JobStatus, jobId, pid } from "./types.ts"

function rec(id: string, status: JobStatus): JobRecord {
  return {
    id: jobId(id),
    command: "echo hi",
    cwd: "/tmp",
    runnerPid: pid(100),
    timeoutMs: 600_000,
    spawnedAt: "2026-06-04T00:00:00.000Z",
    status,
    logPath: `/tmp/${id}.log`,
    statusPath: `/tmp/${id}.status.json`,
  }
}

const running: JobStatus = { kind: "running", pid: pid(1), startedAt: "t" }
const exited: JobStatus = { kind: "exited", endedAt: "t", exitCode: 0 }

describe("parse/serialize", () => {
  test("round trip", () => {
    const records = [rec("j1", running), rec("j2", exited)]
    const text = serializeRecords(records)
    expect(text.endsWith("\n")).toBe(true)
    expect(parseRecords(text)).toEqual(records)
  })
  test("empty -> empty string", () => {
    expect(serializeRecords([])).toBe("")
  })
  test("tolerates corrupt lines", () => {
    const text = `${JSON.stringify(rec("j1", running))}\nnot json\n\n{"no":"id"}\n`
    const out = parseRecords(text)
    expect(out.length).toBe(1)
    expect(String(out[0].id)).toBe("j1")
  })
})

describe("nextId", () => {
  test("monotonic from empty", () => {
    expect(String(nextId([]))).toBe("j1")
  })
  test("max+1, ignores gaps and other prefixes", () => {
    const records = [rec("j1", exited), rec("j5", exited), rec("A3", exited)]
    expect(String(nextId(records))).toBe("j6")
  })
})

describe("evictExcess", () => {
  test("no-op under cap", () => {
    const records = [rec("j1", exited), rec("j2", running)]
    expect(evictExcess(records, 5, (r) => isActive(r.status))).toEqual(records)
  })
  test("evicts oldest terminal, keeps active", () => {
    const records = [
      rec("j1", exited), // oldest terminal -> evicted first
      rec("j2", running), // active -> kept
      rec("j3", exited),
      rec("j4", exited),
    ]
    const out = evictExcess(records, 2, (r) => isActive(r.status))
    const ids = out.map((r) => String(r.id))
    expect(ids).toContain("j2") // active always kept
    expect(out.length).toBe(2)
    expect(ids).not.toContain("j1") // oldest terminal gone
  })
  test("never drops below active count even if over cap", () => {
    const records = [rec("j1", running), rec("j2", running), rec("j3", running)]
    const out = evictExcess(records, 1, (r) => isActive(r.status))
    expect(out.length).toBe(3) // all active, nothing removable
  })
})

describe("BgJobStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bgstore-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("empty when no file", () => {
    const store = new BgJobStore("sid1", { sessionsDir: dir })
    expect(store.all()).toEqual([])
    expect(store.get("j1")).toBeNull()
    expect(String(store.nextId())).toBe("j1")
  })

  test("upsert appends then updates in place", () => {
    const store = new BgJobStore("sid1", { sessionsDir: dir })
    store.upsert(rec("j1", running))
    store.upsert(rec("j2", running))
    expect(store.all().map((r) => String(r.id))).toEqual(["j1", "j2"])
    store.upsert(rec("j1", exited))
    expect(store.get("j1")?.status.kind).toBe("exited")
    expect(store.all().map((r) => String(r.id))).toEqual(["j1", "j2"]) // order preserved
  })

  test("nextId reflects persisted state", () => {
    const store = new BgJobStore("sid1", { sessionsDir: dir })
    store.upsert(rec("j1", running))
    store.upsert(rec("j2", running))
    expect(String(store.nextId())).toBe("j3")
  })

  test("replaceAll overwrites", () => {
    const store = new BgJobStore("sid1", { sessionsDir: dir })
    store.upsert(rec("j1", running))
    store.replaceAll([rec("j9", exited)])
    expect(store.all().map((r) => String(r.id))).toEqual(["j9"])
  })

  test("file path is colocated and named per session", () => {
    const store = new BgJobStore("abc", { sessionsDir: dir })
    expect(store.filePath()).toBe(join(dir, "abc.bgjobs.jsonl"))
  })
})
