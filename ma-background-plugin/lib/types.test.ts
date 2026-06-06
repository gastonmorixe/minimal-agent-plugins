import { describe, expect, test } from "bun:test"

import {
  isActive,
  isSuccess,
  isTerminal,
  type JobRecord,
  type JobStatus,
  jobId,
  jobStats,
  pid,
} from "./types.ts"

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

describe("isTerminal / isActive", () => {
  test("running is active, not terminal", () => {
    const s: JobStatus = { kind: "running", pid: pid(1), startedAt: "t" }
    expect(isActive(s)).toBe(true)
    expect(isTerminal(s)).toBe(false)
  })

  test("every terminal kind is terminal", () => {
    const terminals: JobStatus[] = [
      { kind: "exited", endedAt: "t", exitCode: 0 },
      { kind: "timedout", endedAt: "t", timeoutMs: 1000 },
      { kind: "stopped", endedAt: "t" },
      { kind: "orphaned", endedAt: "t", reason: "x" },
    ]
    for (const s of terminals) {
      expect(isTerminal(s)).toBe(true)
      expect(isActive(s)).toBe(false)
    }
  })
})

describe("isSuccess", () => {
  test("exit 0 is success", () => {
    expect(isSuccess({ kind: "exited", endedAt: "t", exitCode: 0 })).toBe(true)
  })
  test("non-zero exit is not success", () => {
    expect(isSuccess({ kind: "exited", endedAt: "t", exitCode: 1 })).toBe(false)
  })
  test("a signal-only exit is not success", () => {
    expect(isSuccess({ kind: "exited", endedAt: "t", signal: "SIGKILL" })).toBe(false)
  })
  test("non-exited kinds are never success", () => {
    expect(isSuccess({ kind: "stopped", endedAt: "t" })).toBe(false)
    expect(isSuccess({ kind: "running", pid: pid(1), startedAt: "t" })).toBe(false)
  })
})

describe("jobStats", () => {
  test("counts each kind and successes", () => {
    const records: JobRecord[] = [
      rec("j1", { kind: "running", pid: pid(1), startedAt: "t" }),
      rec("j2", { kind: "exited", endedAt: "t", exitCode: 0 }),
      rec("j3", { kind: "exited", endedAt: "t", exitCode: 2 }),
      rec("j4", { kind: "timedout", endedAt: "t", timeoutMs: 1000 }),
      rec("j5", { kind: "stopped", endedAt: "t", reason: "cancel" }),
      rec("j6", { kind: "orphaned", endedAt: "t", reason: "dead runner" }),
    ]
    const s = jobStats(records)
    expect(s).toEqual({
      total: 6,
      running: 1,
      exited: 2,
      timedout: 1,
      stopped: 1,
      orphaned: 1,
      succeeded: 1,
    })
  })

  test("empty set is all zeros", () => {
    expect(jobStats([])).toEqual({
      total: 0,
      running: 0,
      exited: 0,
      timedout: 0,
      stopped: 0,
      orphaned: 0,
      succeeded: 0,
    })
  })
})
