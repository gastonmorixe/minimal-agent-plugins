import { describe, expect, test } from "bun:test"

import {
  parseLogsRequest,
  parseRunRequest,
  parseStatusRequest,
  parseStopRequest,
} from "./validate.ts"

describe("parseRunRequest", () => {
  test("requires command", () => {
    expect(parseRunRequest({}).ok).toBe(false)
    expect(parseRunRequest({ command: 42 }).ok).toBe(false)
    expect(parseRunRequest({ command: "   " }).ok).toBe(false)
  })
  test("minimal command", () => {
    const r = parseRunRequest({ command: "bun test" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.command).toBe("bun test")
  })
  test("full request", () => {
    const r = parseRunRequest({
      command: "make build",
      description: "build",
      cwd: "/proj",
      timeout: "2h",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        command: "make build",
        description: "build",
        cwd: "/proj",
        timeout: "2h",
      })
    }
  })
  test("numeric timeout allowed", () => {
    const r = parseRunRequest({ command: "x", timeout: 90 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.timeout).toBe(90)
  })
  test("bad timeout type rejected", () => {
    expect(parseRunRequest({ command: "x", timeout: true }).ok).toBe(false)
  })
  test("blank description/cwd drop to undefined", () => {
    const r = parseRunRequest({ command: "x", description: "  ", cwd: "" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.description).toBeUndefined()
      expect(r.value.cwd).toBeUndefined()
    }
  })
})

describe("parseStatusRequest", () => {
  test("empty = all", () => {
    const r = parseStatusRequest({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.id).toBeUndefined()
  })
  test("id passes through", () => {
    const r = parseStatusRequest({ id: "j3" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.id).toBe("j3")
  })
  test("non-string id rejected", () => {
    expect(parseStatusRequest({ id: 3 }).ok).toBe(false)
  })
})

describe("parseLogsRequest", () => {
  test("requires id", () => {
    expect(parseLogsRequest({}).ok).toBe(false)
  })
  test("defaults raw false", () => {
    const r = parseLogsRequest({ id: "j1" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.raw).toBe(false)
  })
  test("full params", () => {
    const r = parseLogsRequest({
      id: "j1",
      tail: 20,
      offset: 5,
      limit: 100,
      since: 4096,
      grep: "error",
      raw: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        id: "j1",
        tail: 20,
        offset: 5,
        limit: 100,
        since: 4096,
        grep: "error",
        raw: true,
      })
    }
  })
  test("bad regex rejected", () => {
    expect(parseLogsRequest({ id: "j1", grep: "(" }).ok).toBe(false)
  })
  test("negative numbers rejected", () => {
    expect(parseLogsRequest({ id: "j1", tail: -3 }).ok).toBe(false)
  })
  test("non-boolean raw rejected", () => {
    expect(parseLogsRequest({ id: "j1", raw: "yes" }).ok).toBe(false)
  })
})

describe("parseStopRequest", () => {
  test("empty = stop all", () => {
    const r = parseStopRequest({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.id).toBeUndefined()
  })
  test("signal validated", () => {
    expect(parseStopRequest({ signal: "SIGKILL" }).ok).toBe(true)
    expect(parseStopRequest({ signal: "SIGTERM" }).ok).toBe(true)
    expect(parseStopRequest({ signal: "SIGHUP" }).ok).toBe(false)
  })
  test("reason passes", () => {
    const r = parseStopRequest({ id: "j2", reason: "superseded" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.id).toBe("j2")
      expect(r.value.reason).toBe("superseded")
    }
  })
})
