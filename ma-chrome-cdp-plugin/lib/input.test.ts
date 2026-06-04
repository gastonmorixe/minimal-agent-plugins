import { describe, expect, test } from "bun:test"

import { validateToolInput } from "./input.ts"

describe("validateToolInput", () => {
  test("missing action errors with help", () => {
    const r = validateToolInput({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/action.*required/)
  })

  test("unknown action errors", () => {
    const r = validateToolInput({ action: "fly" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown action "fly"/)
  })

  test("ping needs no params", () => {
    const r = validateToolInput({ action: "ping" })
    expect(r).toEqual({ ok: true, route: "ping", body: {} })
  })

  test("eval maps target+expr", () => {
    const r = validateToolInput({ action: "eval", target: "T", expr: "1+1" })
    expect(r).toEqual({ ok: true, route: "eval", body: { target: "T", expr: "1+1" } })
  })

  test("eval missing expr surfaces the route validator error", () => {
    const r = validateToolInput({ action: "eval", target: "T" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/expr/)
  })

  test("newtab defaults url", () => {
    const r = validateToolInput({ action: "newtab" })
    expect(r).toEqual({ ok: true, route: "newtab", body: { url: "about:blank" } })
  })

  test("frameeval maps all three fields", () => {
    const r = validateToolInput({ action: "frameeval", target: "T", urlSub: "idmsa", expr: "x" })
    expect(r).toEqual({
      ok: true,
      route: "frameeval",
      body: { target: "T", urlSub: "idmsa", expr: "x" },
    })
  })
})
