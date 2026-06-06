import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { defaultConfig } from "./config.ts"
import { RunnerRegistry } from "./registry.ts"
import {
  type ReconcileIO,
  runReconcile,
  type ServiceDeps,
  type ServicePaths,
  startJob,
} from "./service.ts"
import type { Sidecar } from "./sidecar.ts"
import type { LaunchFn, RunnerHandle } from "./spawn.ts"
import { BgJobStore } from "./store.ts"
import { isActive } from "./types.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bgsvc-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function noopRegistry(): RunnerRegistry {
  return new RunnerRegistry({ onParentExit: () => () => {}, killRunner: () => {} })
}

function paths(): ServicePaths {
  return {
    runnerPath: "/pkg/bin/runner.ts",
    runtime: ["bun", "run"],
    logPath: (id) => join(dir, `${id}.log`),
    statusPath: (id) => join(dir, `${id}.status.json`),
    ensureJobsDir: () => {},
  }
}

function fakeLaunch(pidSeq: number[]): { launch: LaunchFn; closed: string[] } {
  const closed: string[] = []
  let i = 0
  const launch: LaunchFn = (spec) => {
    const pid = pidSeq[i++] ?? 1000 + i
    const handle: RunnerHandle = {
      pid,
      closeStdin: () => closed.push(spec.jobId),
    }
    return handle
  }
  return { launch, closed }
}

function deps(over: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    store: new BgJobStore("sid", { sessionsDir: dir }),
    registry: noopRegistry(),
    config: defaultConfig(),
    paths: paths(),
    launch: fakeLaunch([4242]).launch,
    baseEnv: { PATH: "/usr/bin" },
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    ...over,
  }
}

describe("startJob", () => {
  test("happy path persists a running record", () => {
    const d = deps()
    const r = startJob({ command: "bun test", cwd: "/work", timeoutMs: 600_000 }, d)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(String(r.value.id)).toBe("j1")
      expect(r.value.status.kind).toBe("running")
      expect(Number(r.value.runnerPid)).toBe(4242)
      expect(r.value.logPath).toBe(join(dir, "j1.log"))
    }
    expect(d.store.all().length).toBe(1)
  })

  test("description carried through", () => {
    const r = startJob(
      { command: "make", description: "build", cwd: "/work", timeoutMs: 1000 },
      deps(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.description).toBe("build")
  })

  test("empty command rejected", () => {
    const r = startJob({ command: "   ", cwd: "/work", timeoutMs: 1000 }, deps())
    expect(r.ok).toBe(false)
  })

  test("concurrency cap enforced", () => {
    const cfg = { ...defaultConfig(), limits: { maxConcurrent: 1, maxTotal: 128 } }
    const d = deps({ config: cfg, launch: fakeLaunch([1, 2, 3]).launch })
    expect(startJob({ command: "a", cwd: "/w", timeoutMs: 1000 }, d).ok).toBe(true)
    const second = startJob({ command: "b", cwd: "/w", timeoutMs: 1000 }, d)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toContain("too many")
  })

  test("ids increment across calls", () => {
    const d = deps({ launch: fakeLaunch([1, 2]).launch })
    const a = startJob({ command: "a", cwd: "/w", timeoutMs: 1000 }, d)
    const b = startJob({ command: "b", cwd: "/w", timeoutMs: 1000 }, d)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(String(a.value.id)).toBe("j1")
      expect(String(b.value.id)).toBe("j2")
    }
  })

  test("a failing launcher surfaces an error and persists nothing", () => {
    const d = deps({
      launch: () => {
        throw new Error("boom")
      },
    })
    const r = startJob({ command: "a", cwd: "/w", timeoutMs: 1000 }, d)
    expect(r.ok).toBe(false)
    expect(d.store.all().length).toBe(0)
  })

  test("evicts oldest terminal records past maxTotal", () => {
    const cfg = { ...defaultConfig(), limits: { maxConcurrent: 16, maxTotal: 2 } }
    const store = new BgJobStore("sid", { sessionsDir: dir })
    // seed two terminal records
    store.replaceAll([
      {
        id: "j1" as never,
        command: "old",
        cwd: "/w",
        runnerPid: 1 as never,
        timeoutMs: 1000,
        spawnedAt: "t",
        status: { kind: "exited", endedAt: "t", exitCode: 0 },
        logPath: "/l",
        statusPath: "/s",
      },
      {
        id: "j2" as never,
        command: "old2",
        cwd: "/w",
        runnerPid: 2 as never,
        timeoutMs: 1000,
        spawnedAt: "t",
        status: { kind: "exited", endedAt: "t", exitCode: 0 },
        logPath: "/l",
        statusPath: "/s",
      },
    ])
    const d = deps({ store, config: cfg, launch: fakeLaunch([9]).launch })
    const r = startJob({ command: "new", cwd: "/w", timeoutMs: 1000 }, d)
    expect(r.ok).toBe(true)
    const ids = store.all().map((x) => String(x.id))
    expect(ids).toContain("j3") // new one kept
    expect(ids.length).toBe(2) // capped
    expect(ids).not.toContain("j1") // oldest terminal evicted
  })
})

describe("runReconcile", () => {
  function seedRunning(store: BgJobStore, id: string, runnerPid: number): void {
    store.upsert({
      id: id as never,
      command: "sleep 1",
      cwd: "/w",
      runnerPid: runnerPid as never,
      timeoutMs: 1000,
      spawnedAt: "t",
      status: { kind: "running", pid: runnerPid as never, startedAt: "t" },
      logPath: join(dir, `${id}.log`),
      statusPath: join(dir, `${id}.status.json`),
    })
  }

  test("alive runner with running sidecar -> stays running, no effects", () => {
    const store = new BgJobStore("sid", { sessionsDir: dir })
    seedRunning(store, "j1", 50)
    const io: ReconcileIO = {
      runnerAlive: () => true,
      readSidecar: () => ({ v: 1, id: "j1", phase: "running", startedAt: "t", jobPid: 51 }),
    }
    const res = runReconcile(deps({ store }), io)
    expect(res.records[0].status.kind).toBe("running")
    expect(res.effects.length).toBe(0)
  })

  test("dead runner + exited sidecar -> exited + digest effect", () => {
    const store = new BgJobStore("sid", { sessionsDir: dir })
    seedRunning(store, "j1", 50)
    const sidecar: Sidecar = {
      v: 1,
      id: "j1",
      phase: "exited",
      startedAt: "t",
      endedAt: "t2",
      exitCode: 0,
    }
    const io: ReconcileIO = { runnerAlive: () => false, readSidecar: () => sidecar }
    const res = runReconcile(deps({ store }), io)
    expect(res.records[0].status.kind).toBe("exited")
    expect(res.effects.some((e) => e.type === "inject")).toBe(true)
    // persisted
    expect(store.get("j1")?.status.kind).toBe("exited")
  })

  test("dead runner + no sidecar -> orphaned", () => {
    const store = new BgJobStore("sid", { sessionsDir: dir })
    seedRunning(store, "j1", 50)
    const io: ReconcileIO = { runnerAlive: () => false, readSidecar: () => undefined }
    const res = runReconcile(deps({ store }), io)
    expect(res.records[0].status.kind).toBe("orphaned")
  })

  test("forgets a job that became terminal", () => {
    const store = new BgJobStore("sid", { sessionsDir: dir })
    seedRunning(store, "j1", 50)
    const registry = noopRegistry()
    let forgotten = false
    // track a fake handle so forget() has something to drop
    registry.track("j1", { pid: 50, closeStdin: () => (forgotten = true) })
    const io: ReconcileIO = {
      runnerAlive: () => false,
      readSidecar: () => ({ v: 1, id: "j1", phase: "exited", startedAt: "t", exitCode: 0 }),
    }
    runReconcile(deps({ store, registry }), io)
    expect(forgotten).toBe(true)
    expect(registry.size()).toBe(0)
  })

  test("terminal records are not re-probed", () => {
    const store = new BgJobStore("sid", { sessionsDir: dir })
    store.upsert({
      id: "j1" as never,
      command: "x",
      cwd: "/w",
      runnerPid: 1 as never,
      timeoutMs: 1000,
      spawnedAt: "t",
      status: { kind: "exited", endedAt: "t", exitCode: 0 },
      logPath: "/l",
      statusPath: "/s",
    })
    let probed = false
    const io: ReconcileIO = {
      runnerAlive: () => {
        probed = true
        return false
      },
      readSidecar: () => undefined,
    }
    const res = runReconcile(deps({ store }), io)
    expect(probed).toBe(false)
    expect(res.changed).toBe(false)
    expect(res.records.every((r) => !isActive(r.status))).toBe(true)
  })
})
