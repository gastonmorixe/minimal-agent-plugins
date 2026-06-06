import { describe, expect, test } from "bun:test"

import { type RegistryDeps, RunnerRegistry } from "./registry.ts"
import type { RunnerHandle } from "./spawn.ts"

interface Killed {
  pid: number
  signal: string
}

function makeDeps(): {
  deps: RegistryDeps
  fireParentExit: () => void
  kills: Killed[]
  parentSubs: number
} {
  const state = { kills: [] as Killed[], parentSubs: 0, cbs: new Set<() => void>() }
  const deps: RegistryDeps = {
    onParentExit: (cb) => {
      state.parentSubs++
      state.cbs.add(cb)
      return () => {
        state.parentSubs--
        state.cbs.delete(cb)
      }
    },
    killRunner: (pid, signal) => state.kills.push({ pid, signal }),
  }
  return {
    deps,
    fireParentExit: () => {
      for (const cb of [...state.cbs]) cb()
    },
    kills: state.kills,
    get parentSubs() {
      return state.parentSubs
    },
  } as unknown as {
    deps: RegistryDeps
    fireParentExit: () => void
    kills: Killed[]
    parentSubs: number
  }
}

function handle(pid: number): { handle: RunnerHandle; closed: () => boolean } {
  let closed = false
  return {
    handle: { pid, closeStdin: () => (closed = true) },
    closed: () => closed,
  }
}

describe("RunnerRegistry tracking", () => {
  test("track/get/ids/size", () => {
    const { deps } = makeDeps()
    const reg = new RunnerRegistry(deps)
    const h1 = handle(10)
    reg.track("j1", h1.handle)
    expect(reg.size()).toBe(1)
    expect(reg.get("j1")?.pid).toBe(10)
    expect(reg.ids()).toEqual(["j1"])
  })

  test("re-track replaces", () => {
    const { deps } = makeDeps()
    const reg = new RunnerRegistry(deps)
    reg.track("j1", handle(10).handle)
    reg.track("j1", handle(20).handle)
    expect(reg.size()).toBe(1)
    expect(reg.get("j1")?.pid).toBe(20)
  })
})

describe("RunnerRegistry stop", () => {
  test("stop kills the runner group and closes the pipe", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    const h = handle(10)
    reg.track("j1", h.handle)
    expect(reg.stop("j1", "SIGKILL")).toBe(true)
    expect(d.kills).toEqual([{ pid: 10, signal: "SIGKILL" }])
    expect(h.closed()).toBe(true)
    expect(reg.size()).toBe(0)
  })

  test("stop unknown job returns false", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    expect(reg.stop("nope")).toBe(false)
  })

  test("default signal is SIGTERM", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    reg.track("j1", handle(7).handle)
    reg.stop("j1")
    expect(d.kills[0].signal).toBe("SIGTERM")
  })

  test("stopAll stops every tracked job", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    reg.track("j1", handle(1).handle)
    reg.track("j2", handle(2).handle)
    expect(reg.stopAll("SIGKILL").sort()).toEqual(["j1", "j2"])
    expect(d.kills.map((k) => k.pid).sort()).toEqual([1, 2])
    expect(reg.size()).toBe(0)
  })
})

describe("RunnerRegistry forget", () => {
  test("forget closes pipe and drops without killing", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    const h = handle(10)
    reg.track("j1", h.handle)
    reg.forget("j1")
    expect(h.closed()).toBe(true)
    expect(d.kills.length).toBe(0)
    expect(reg.size()).toBe(0)
  })
})

describe("RunnerRegistry parent-exit fan-out", () => {
  test("installs hook once, closes all pipes on exit", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    const h1 = handle(1)
    const h2 = handle(2)
    reg.track("j1", h1.handle)
    reg.track("j2", h2.handle)
    expect(d.parentSubs).toBe(1) // installed once, not per-job
    d.fireParentExit()
    expect(h1.closed()).toBe(true)
    expect(h2.closed()).toBe(true)
  })

  test("hook torn down when registry empties", () => {
    const d = makeDeps()
    const reg = new RunnerRegistry(d.deps)
    reg.track("j1", handle(1).handle)
    expect(d.parentSubs).toBe(1)
    reg.stop("j1")
    expect(d.parentSubs).toBe(0)
  })
})
