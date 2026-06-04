import { describe, expect, test } from "bun:test"

import { type SpeechController, SpeechRegistry } from "../lib/registry.ts"

import { runStatus, statusContent } from "./speak_status.ts"

function ctrl(pid = 1): SpeechController {
  return { pid, stop() {} }
}

function regWith(): SpeechRegistry {
  return new SpeechRegistry()
}

describe("runStatus - no id (all jobs)", () => {
  test("empty registry reports nothing playing", () => {
    const res = runStatus(regWith(), undefined, 0)
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeUndefined()
      expect(res.content).toMatch(/No speech jobs/)
    }
  })

  test("reports active jobs and a summary", () => {
    const r = regWith()
    r.register({ controller: ctrl(), backend: "macos-say", text: "a" })
    const b = r.register({ controller: ctrl(), backend: "macos-say", text: "b" })
    r.markDone(b.id)
    const res = runStatus(r, undefined, 0)
    if (res.kind === "tool_result") {
      expect(res.content).toMatch(/speaking now/)
      expect(res.content).toMatch(/s1=speaking/)
      expect(res.content).toMatch(/s2=done/)
    }
  })

  test("all-terminal reports no speech playing", () => {
    const r = regWith()
    const a = r.register({ controller: ctrl(), backend: "macos-say", text: "a" })
    r.markDone(a.id)
    const res = runStatus(r, undefined, 0)
    if (res.kind === "tool_result") {
      expect(res.content).toMatch(/No speech is playing/)
    }
  })
})

describe("runStatus - by id", () => {
  test("unknown id is an error", () => {
    const res = runStatus(regWith(), "s9", 0)
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/no speech job with handle "s9"/)
    }
  })

  test("known speaking job", () => {
    const r = regWith()
    r.register({ controller: ctrl(4242), backend: "macos-say", text: "hello" })
    const res = runStatus(r, "s1", 0)
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeUndefined()
      expect(res.content).toMatch(/still speaking/)
      expect(res.content).toMatch(/pid 4242/)
    }
  })

  test("known done job", () => {
    const r = regWith()
    const a = r.register({ controller: ctrl(), backend: "macos-say", text: "hello" })
    r.markDone(a.id)
    const res = runStatus(r, "s1", 0)
    if (res.kind === "tool_result") expect(res.content).toMatch(/finished/)
  })
})

describe("statusContent", () => {
  const base = {
    id: "s1",
    pid: 7,
    backend: "macos-say",
    charCount: 5,
    preview: "x",
    startedAt: 0,
  }

  test("failed surfaces the reason", () => {
    expect(
      statusContent({ ...base, state: "failed", failureReason: "Audio output is unavailable." }),
    ).toMatch(/Audio output is unavailable/)
  })

  test("stopped is reported", () => {
    expect(statusContent({ ...base, state: "stopped" })).toMatch(/stopped/)
  })
})
