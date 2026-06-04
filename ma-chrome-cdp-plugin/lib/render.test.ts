import { describe, expect, test } from "bun:test"

import { isErrorBody, renderContent, summarize } from "./render.ts"

describe("summarize", () => {
  test("targets counts", () => {
    expect(summarize("targets", [{ id: "a" }, { id: "b" }])).toBe("2 target(s)")
  })
  test("downloads counts", () => {
    expect(summarize("downloads", [{ guid: "g" }])).toBe("1 download(s)")
  })
  test("ping connected", () => {
    expect(summarize("ping", { connected: true })).toBe("connected")
    expect(summarize("ping", { connected: false })).toBe("disconnected")
  })
  test("newtab shows id", () => {
    expect(summarize("newtab", { id: "ABCDEF0123456789" })).toMatch(/^new tab ABCDEF012345/)
  })
  test("eval ok vs error", () => {
    expect(summarize("eval", { result: 42 })).toBe("ok")
    expect(summarize("eval", { result: { __error: "boom" } })).toBe("eval error")
  })
  test("ok-shaped body", () => {
    expect(summarize("nav", { ok: true })).toBe("ok")
  })
})

describe("renderContent", () => {
  test("pretty prints JSON", () => {
    expect(renderContent({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
  test("truncates very large output", () => {
    const big = { s: "x".repeat(50_000) }
    const out = renderContent(big, 1000)
    expect(out.length).toBeLessThan(1100)
    expect(out).toMatch(/more chars truncated/)
  })
})

describe("isErrorBody", () => {
  test("http >= 400 is an error", () => {
    expect(isErrorBody(404, { error: "x" })).toBe(true)
    expect(isErrorBody(400, {})).toBe(true)
  })
  test("error field is an error", () => {
    expect(isErrorBody(200, { error: "bad" })).toBe(true)
  })
  test("eval __error is an error", () => {
    expect(isErrorBody(200, { result: { __error: "boom" } })).toBe(true)
  })
  test("clean 200 is not an error", () => {
    expect(isErrorBody(200, { result: 42 })).toBe(false)
    expect(isErrorBody(200, [{ id: "a" }])).toBe(false)
  })
})
