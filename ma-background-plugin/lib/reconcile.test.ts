import { describe, expect, test } from "bun:test"

import { completionDigest, type JobProbe, reconcile } from "./reconcile.ts"
import type { Sidecar } from "./sidecar.ts"
import { type JobRecord, type JobStatus, jobId, pid } from "./types.ts"

const NOW = "2026-06-04T01:00:00.000Z"

function rec(id: string, status: JobStatus, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: jobId(id),
    command: "bun test",
    cwd: "/tmp",
    runnerPid: pid(100),
    timeoutMs: 600_000,
    spawnedAt: "2026-06-04T00:00:00.000Z",
    status,
    logPath: `/tmp/${id}.log`,
    statusPath: `/tmp/${id}.status.json`,
    ...over,
  }
}

const running: JobStatus = { kind: "running", pid: pid(1), startedAt: "t" }

function probes(map: Record<string, JobProbe>): Map<string, JobProbe> {
  return new Map(Object.entries(map))
}

describe("reconcile: running stays running", () => {
  test("runner alive, sidecar running -> no change", () => {
    const records = [rec("j1", running)]
    const sidecar: Sidecar = { v: 1, id: "j1", phase: "running", startedAt: "t", jobPid: 5 }
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: true, sidecar } }),
    })
    expect(out.changed).toBe(true) // jobPid learned
    expect(out.records[0].status.kind).toBe("running")
    expect(Number(out.records[0].jobPid)).toBe(5)
    expect(out.effects.length).toBe(0)
  })

  test("no probe -> unchanged", () => {
    const records = [rec("j1", running, { jobPid: pid(5) })]
    const out = reconcile({ records, now: NOW, probes: probes({}) })
    expect(out.changed).toBe(false)
    expect(out.effects.length).toBe(0)
  })
})

describe("reconcile: terminal transitions", () => {
  test("sidecar exited 0 while runner still alive -> exited + digest", () => {
    const records = [rec("j1", running)]
    const sidecar: Sidecar = {
      v: 1,
      id: "j1",
      phase: "exited",
      startedAt: "t",
      endedAt: "t2",
      exitCode: 0,
    }
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: true, sidecar } }),
    })
    expect(out.changed).toBe(true)
    expect(out.records[0].status).toMatchObject({ kind: "exited", exitCode: 0, endedAt: "t2" })
    const kinds = out.effects.map((e) => e.type)
    expect(kinds).toEqual(["emit", "inject"])
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject && "text" in inject ? inject.text : "").toContain("succeeded")
  })

  test("runner gone + terminal sidecar -> trusts sidecar", () => {
    const records = [rec("j1", running)]
    const sidecar: Sidecar = {
      v: 1,
      id: "j1",
      phase: "exited",
      startedAt: "t",
      endedAt: "t2",
      exitCode: 3,
    }
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: false, sidecar } }),
    })
    expect(out.records[0].status).toMatchObject({ kind: "exited", exitCode: 3 })
  })

  test("runner gone, no sidecar -> orphaned", () => {
    const records = [rec("j1", running)]
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: false } }),
    })
    expect(out.records[0].status.kind).toBe("orphaned")
    expect(out.effects.some((e) => e.type === "inject")).toBe(true)
  })

  test("runner gone, sidecar says still running -> orphaned (runner crashed mid-run)", () => {
    const records = [rec("j1", running)]
    const sidecar: Sidecar = { v: 1, id: "j1", phase: "running", startedAt: "t" }
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: false, sidecar } }),
    })
    expect(out.records[0].status.kind).toBe("orphaned")
  })

  test("timedout sidecar maps through", () => {
    const records = [rec("j1", running)]
    const sidecar: Sidecar = {
      v: 1,
      id: "j1",
      phase: "timedout",
      startedAt: "t",
      endedAt: "t2",
      timeoutMs: 5000,
    }
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: false, sidecar } }),
    })
    expect(out.records[0].status).toMatchObject({ kind: "timedout", timeoutMs: 5000 })
  })

  test("stopped sidecar maps through with reason", () => {
    const records = [rec("j1", running)]
    const sidecar: Sidecar = {
      v: 1,
      id: "j1",
      phase: "stopped",
      startedAt: "t",
      endedAt: "t2",
      reason: "cancelled by user",
    }
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: false, sidecar } }),
    })
    expect(out.records[0].status).toMatchObject({ kind: "stopped", reason: "cancelled by user" })
  })
})

describe("reconcile: terminal records are inert", () => {
  test("already-exited record never re-emits", () => {
    const records = [rec("j1", { kind: "exited", endedAt: "t", exitCode: 0 })]
    const out = reconcile({
      records,
      now: NOW,
      probes: probes({ j1: { runnerAlive: false } }),
    })
    expect(out.changed).toBe(false)
    expect(out.effects.length).toBe(0)
  })
})

describe("completionDigest", () => {
  test("success", () => {
    const d = completionDigest(rec("j1", { kind: "exited", endedAt: "t", exitCode: 0 }))
    expect(d).toContain("succeeded")
    expect(d).toContain("BackgroundLogs j1")
  })
  test("failure", () => {
    const d = completionDigest(rec("j1", { kind: "exited", endedAt: "t", exitCode: 1 }))
    expect(d).toContain("FAILED")
  })
  test("timed out", () => {
    const d = completionDigest(rec("j1", { kind: "timedout", endedAt: "t", timeoutMs: 600_000 }))
    expect(d).toContain("timed out after 10m")
  })
  test("uses description when present", () => {
    const d = completionDigest(
      rec("j1", { kind: "exited", endedAt: "t", exitCode: 0 }, { description: "the build" }),
    )
    expect(d).toContain("j1 (the build)")
  })
})
