import { describe, expect, test } from "bun:test"

import { parseSidecar, type Sidecar, serializeSidecar } from "./sidecar.ts"

describe("parseSidecar", () => {
  test("valid running sidecar", () => {
    const s = parseSidecar({ v: 1, id: "j1", phase: "running", startedAt: "t", jobPid: 42 })
    expect(s).toEqual({ v: 1, id: "j1", phase: "running", startedAt: "t", jobPid: 42 })
  })

  test("valid exited sidecar with all fields", () => {
    const raw = {
      v: 1,
      id: "j2",
      phase: "exited",
      startedAt: "t0",
      endedAt: "t1",
      exitCode: 0,
      bytesLogged: 1234,
    }
    const s = parseSidecar(raw)
    expect(s?.phase).toBe("exited")
    expect(s?.exitCode).toBe(0)
    expect(s?.bytesLogged).toBe(1234)
  })

  test("rejects wrong version", () => {
    expect(parseSidecar({ v: 2, id: "j1", phase: "running", startedAt: "t" })).toBeUndefined()
  })

  test("rejects missing/invalid fields", () => {
    expect(parseSidecar(null)).toBeUndefined()
    expect(parseSidecar({})).toBeUndefined()
    expect(parseSidecar({ v: 1, id: "j1", phase: "bogus", startedAt: "t" })).toBeUndefined()
    expect(parseSidecar({ v: 1, id: 1, phase: "running", startedAt: "t" })).toBeUndefined()
    expect(parseSidecar({ v: 1, id: "j1", phase: "running" })).toBeUndefined()
  })

  test("drops unknown / wrong-type optionals", () => {
    const s = parseSidecar({
      v: 1,
      id: "j1",
      phase: "running",
      startedAt: "t",
      jobPid: "nope",
      extra: true,
    })
    expect(s).toEqual({ v: 1, id: "j1", phase: "running", startedAt: "t" })
  })

  test("round-trips through serialize", () => {
    const s: Sidecar = {
      v: 1,
      id: "j9",
      phase: "stopped",
      startedAt: "t0",
      endedAt: "t1",
      reason: "cancel",
      signal: "SIGTERM",
    }
    expect(parseSidecar(JSON.parse(serializeSidecar(s)))).toEqual(s)
  })
})
