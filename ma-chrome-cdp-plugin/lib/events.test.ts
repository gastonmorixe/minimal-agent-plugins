import { describe, expect, test } from "bun:test"

import { EventBuffer } from "./events.ts"

describe("EventBuffer", () => {
  test("records nothing until recording is enabled", () => {
    const b = new EventBuffer()
    expect(b.record("Network.responseReceived", "S", {})).toBe(-1)
    expect(b.query().buffered).toBe(0)
    b.setRecording(true)
    expect(b.record("Network.responseReceived", "S", {})).toBe(1)
    expect(b.query().buffered).toBe(1)
  })

  test("assigns monotonic seq and reports a cursor", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    b.record("A.x", "", {})
    b.record("B.y", "", {})
    const r = b.query()
    expect(r.events.map((e) => e.seq)).toEqual([1, 2])
    expect(r.cursor).toBe(2)
  })

  test("since cursor drains incrementally", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    b.record("A.x", "", {})
    b.record("B.y", "", {})
    const first = b.query()
    b.record("C.z", "", {})
    const next = b.query({ since: first.cursor })
    expect(next.events.map((e) => e.method)).toEqual(["C.z"])
  })

  test("filter matches method substring case-insensitively", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    b.record("Network.requestWillBeSent", "", {})
    b.record("Log.entryAdded", "", {})
    b.record("Network.responseReceived", "", {})
    expect(b.query({ filter: "network" }).events).toHaveLength(2)
    expect(b.query({ filter: "Log." }).events).toHaveLength(1)
  })

  test("sessionId filter narrows to one session", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    b.record("A.x", "S1", {})
    b.record("A.x", "S2", {})
    expect(b.query({ sessionId: "S2" }).events).toHaveLength(1)
  })

  test("limit keeps the most recent matches", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    for (let i = 0; i < 5; i++) b.record(`M.${i}`, "", { i })
    const r = b.query({ limit: 2 })
    expect(r.events.map((e) => e.method)).toEqual(["M.3", "M.4"])
  })

  test("evicts oldest past capacity and counts drops; seq keeps climbing", () => {
    const b = new EventBuffer(3)
    b.setRecording(true)
    for (let i = 0; i < 5; i++) b.record(`M.${i}`, "", {})
    const r = b.query()
    expect(r.buffered).toBe(3)
    expect(r.dropped).toBe(2)
    expect(r.events.map((e) => e.method)).toEqual(["M.2", "M.3", "M.4"])
    expect(r.cursor).toBe(5)
  })

  test("clear drops events but not the seq counter", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    b.record("A.x", "", {})
    b.clear()
    expect(b.query().buffered).toBe(0)
    b.record("B.y", "", {})
    expect(b.query().events[0]?.seq).toBe(2)
  })

  test("countByMethod groups retained events", () => {
    const b = new EventBuffer()
    b.setRecording(true)
    b.record("Network.x", "", {})
    b.record("Network.x", "", {})
    b.record("Log.y", "", {})
    expect(b.countByMethod()).toEqual({ "Network.x": 2, "Log.y": 1 })
  })
})
