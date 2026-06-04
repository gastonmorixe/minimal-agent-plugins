import { describe, expect, test } from "bun:test"

import {
  getRegistry,
  isTerminal,
  makePreview,
  resetRegistryForTests,
  type SpeechController,
  SpeechRegistry,
} from "./registry.ts"

/** A fake controller that records whether stop() was called. */
function fakeController(pid = 1234): SpeechController & { stopped: number } {
  const c = {
    pid,
    stopped: 0,
    stop() {
      c.stopped += 1
    },
  }
  return c
}

describe("makePreview", () => {
  test("collapses whitespace and trims", () => {
    expect(makePreview("  hello   world\n\tfoo ")).toBe("hello world foo")
  })

  test("clips long text with an ellipsis", () => {
    const p = makePreview("a".repeat(200), 10)
    expect(p.length).toBe(10)
    expect(p.endsWith("…")).toBe(true)
  })

  test("short text passes through unchanged", () => {
    expect(makePreview("short", 80)).toBe("short")
  })
})

describe("isTerminal", () => {
  test("speaking is not terminal; others are", () => {
    expect(isTerminal("speaking")).toBe(false)
    expect(isTerminal("done")).toBe(true)
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("stopped")).toBe(true)
  })
})

describe("SpeechRegistry - register", () => {
  test("mints monotonic s-prefixed handles", () => {
    const r = new SpeechRegistry()
    const a = r.register({ controller: fakeController(), backend: "macos-say", text: "one" })
    const b = r.register({ controller: fakeController(), backend: "macos-say", text: "two" })
    expect(a.id).toBe("s1")
    expect(b.id).toBe("s2")
  })

  test("captures pid, backend, charCount, preview, state, startedAt", () => {
    const r = new SpeechRegistry({ now: () => 5000 })
    const job = r.register({
      controller: fakeController(4321),
      backend: "macos-say",
      text: "hello there",
    })
    expect(job.pid).toBe(4321)
    expect(job.backend).toBe("macos-say")
    expect(job.charCount).toBe("hello there".length)
    expect(job.preview).toBe("hello there")
    expect(job.state).toBe("speaking")
    expect(job.startedAt).toBe(5000)
    expect(job.endedAt).toBeUndefined()
  })
})

describe("SpeechRegistry - get / list / active", () => {
  test("get returns the public view; unknown id → undefined", () => {
    const r = new SpeechRegistry()
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    expect(r.get(job.id)?.id).toBe(job.id)
    expect(r.get("nope")).toBeUndefined()
  })

  test("list is oldest-first; active excludes terminal jobs", () => {
    const r = new SpeechRegistry()
    const a = r.register({ controller: fakeController(), backend: "macos-say", text: "a" })
    const b = r.register({ controller: fakeController(), backend: "macos-say", text: "b" })
    r.markDone(a.id)
    expect(r.list().map((j) => j.id)).toEqual([a.id, b.id])
    expect(r.active().map((j) => j.id)).toEqual([b.id])
  })
})

describe("SpeechRegistry - state transitions", () => {
  test("markDone moves speaking → done with exit code and endedAt", () => {
    const r = new SpeechRegistry({ now: () => 9000 })
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    const done = r.markDone(job.id, 0)
    expect(done?.state).toBe("done")
    expect(done?.exitCode).toBe(0)
    expect(done?.endedAt).toBe(9000)
  })

  test("markFailed records exit code and reason", () => {
    const r = new SpeechRegistry()
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    const failed = r.markFailed(job.id, 2, "speech engine unavailable")
    expect(failed?.state).toBe("failed")
    expect(failed?.exitCode).toBe(2)
    expect(failed?.failureReason).toBe("speech engine unavailable")
  })

  test("markStopped records an interruption (no failure reason)", () => {
    const r = new SpeechRegistry()
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    const stopped = r.markStopped(job.id, 143)
    expect(stopped?.state).toBe("stopped")
    expect(stopped?.exitCode).toBe(143)
    expect(stopped?.failureReason).toBeUndefined()
  })

  test("markStopped is monotonic: a stopped job stays stopped, not failed", () => {
    const r = new SpeechRegistry()
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    r.markStopped(job.id)
    // The reaper's later markStopped/markFailed on a killed job is a no-op.
    expect(r.markFailed(job.id, 1, "late")?.state).toBe("stopped")
  })

  test("transitions are monotonic: a terminal job does not change", () => {
    const r = new SpeechRegistry()
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    r.markDone(job.id, 0)
    // Later exit signals must not flip done → failed.
    const again = r.markFailed(job.id, 1, "late")
    expect(again?.state).toBe("done")
    expect(again?.failureReason).toBeUndefined()
  })

  test("unknown id transitions return undefined", () => {
    const r = new SpeechRegistry()
    expect(r.markDone("ghost")).toBeUndefined()
    expect(r.markFailed("ghost", 1, "x")).toBeUndefined()
    expect(r.stop("ghost")).toBeUndefined()
  })
})

describe("SpeechRegistry - stop", () => {
  test("stop signals the controller and marks stopped", () => {
    const r = new SpeechRegistry()
    const ctrl = fakeController()
    const job = r.register({ controller: ctrl, backend: "macos-say", text: "x" })
    const stopped = r.stop(job.id)
    expect(stopped?.state).toBe("stopped")
    expect(ctrl.stopped).toBe(1)
  })

  test("stop on an already-terminal job does not signal again", () => {
    const r = new SpeechRegistry()
    const ctrl = fakeController()
    const job = r.register({ controller: ctrl, backend: "macos-say", text: "x" })
    r.markDone(job.id)
    const res = r.stop(job.id)
    expect(res?.state).toBe("done")
    expect(ctrl.stopped).toBe(0)
  })

  test("a controller.stop() that throws still transitions to stopped", () => {
    const r = new SpeechRegistry()
    const ctrl: SpeechController = {
      pid: 1,
      stop() {
        throw new Error("ESRCH")
      },
    }
    const job = r.register({ controller: ctrl, backend: "macos-say", text: "x" })
    expect(r.stop(job.id)?.state).toBe("stopped")
  })

  test("stopAll stops every speaking job and returns them", () => {
    const r = new SpeechRegistry()
    const a = r.register({ controller: fakeController(), backend: "macos-say", text: "a" })
    const b = r.register({ controller: fakeController(), backend: "macos-say", text: "b" })
    const c = r.register({ controller: fakeController(), backend: "macos-say", text: "c" })
    r.markDone(c.id)
    const stopped = r.stopAll()
    expect(stopped.map((j) => j.id).sort()).toEqual([a.id, b.id])
    expect(r.get(c.id)?.state).toBe("done")
  })

  test("stop after exit reaper: stopped wins because it ran first", () => {
    // Models the race where the user stops, THEN the process-exit reaper
    // fires markDone. The stop already moved the job to terminal, so the
    // late markDone is a no-op.
    const r = new SpeechRegistry()
    const job = r.register({ controller: fakeController(), backend: "macos-say", text: "x" })
    r.stop(job.id)
    r.markDone(job.id, 0)
    expect(r.get(job.id)?.state).toBe("stopped")
  })
})

describe("SpeechRegistry - eviction", () => {
  test("evicts oldest terminal jobs past the cap but keeps speaking ones", () => {
    const r = new SpeechRegistry({ maxJobs: 3 })
    const a = r.register({ controller: fakeController(), backend: "macos-say", text: "a" })
    const b = r.register({ controller: fakeController(), backend: "macos-say", text: "b" })
    r.markDone(a.id)
    r.markDone(b.id)
    // b is speaking? no, both done. Register more to push over cap.
    r.register({ controller: fakeController(), backend: "macos-say", text: "c" })
    r.register({ controller: fakeController(), backend: "macos-say", text: "d" })
    // Oldest terminal (a) should have been evicted to stay near the cap.
    expect(r.get(a.id)).toBeUndefined()
  })

  test("never evicts a speaking job even when over cap", () => {
    const r = new SpeechRegistry({ maxJobs: 2 })
    const a = r.register({ controller: fakeController(), backend: "macos-say", text: "a" })
    const b = r.register({ controller: fakeController(), backend: "macos-say", text: "b" })
    const c = r.register({ controller: fakeController(), backend: "macos-say", text: "c" })
    // All three still speaking → none evictable; all retained.
    expect(r.get(a.id)).toBeDefined()
    expect(r.get(b.id)).toBeDefined()
    expect(r.get(c.id)).toBeDefined()
  })
})

describe("getRegistry singleton", () => {
  test("returns the same instance until reset", () => {
    resetRegistryForTests()
    const r1 = getRegistry()
    const r2 = getRegistry()
    expect(r1).toBe(r2)
    resetRegistryForTests()
    expect(getRegistry()).not.toBe(r1)
  })
})
