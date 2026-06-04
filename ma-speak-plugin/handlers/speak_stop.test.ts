import { describe, expect, test } from "bun:test"

import { type SpeechController, SpeechRegistry } from "../lib/registry.ts"

import { runStop } from "./speak_stop.ts"

function trackingCtrl(pid = 1): SpeechController & { stopped: number } {
  const c = {
    pid,
    stopped: 0,
    stop() {
      c.stopped += 1
    },
  }
  return c
}

describe("runStop - by id", () => {
  test("unknown id is an error", () => {
    const res = runStop(new SpeechRegistry(), "s9", 0)
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/no speech job with handle "s9"/)
    }
  })

  test("stops a speaking job and signals its controller", () => {
    const r = new SpeechRegistry()
    const ctrl = trackingCtrl()
    r.register({ controller: ctrl, backend: "macos-say", text: "x" })
    const res = runStop(r, "s1", 0)
    expect(ctrl.stopped).toBe(1)
    expect(r.get("s1")?.state).toBe("stopped")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeUndefined()
      expect(res.content).toMatch(/Stopped speech job s1/)
    }
  })

  test("stopping an already-done job is a reported no-op", () => {
    const r = new SpeechRegistry()
    const ctrl = trackingCtrl()
    const a = r.register({ controller: ctrl, backend: "macos-say", text: "x" })
    r.markDone(a.id)
    const res = runStop(r, "s1", 0)
    expect(ctrl.stopped).toBe(0)
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeUndefined()
      expect(res.content).toMatch(/already done; nothing to stop/)
    }
  })
})

describe("runStop - all (no id)", () => {
  test("nothing playing → reported no-op", () => {
    const res = runStop(new SpeechRegistry(), undefined, 0)
    if (res.kind === "tool_result") {
      expect(res.content).toMatch(/No speech is playing/)
    }
  })

  test("stops every active job and lists them", () => {
    const r = new SpeechRegistry()
    const a = trackingCtrl()
    const b = trackingCtrl()
    const c = trackingCtrl()
    r.register({ controller: a, backend: "macos-say", text: "a" })
    r.register({ controller: b, backend: "macos-say", text: "b" })
    const cj = r.register({ controller: c, backend: "macos-say", text: "c" })
    r.markDone(cj.id) // c already finished

    const res = runStop(r, undefined, 0)
    expect(a.stopped).toBe(1)
    expect(b.stopped).toBe(1)
    expect(c.stopped).toBe(0) // already done, not signaled
    if (res.kind === "tool_result") {
      expect(res.content).toMatch(/Stopped 2 speech job/)
      expect(res.content).toMatch(/s1/)
      expect(res.content).toMatch(/s2/)
    }
  })
})
