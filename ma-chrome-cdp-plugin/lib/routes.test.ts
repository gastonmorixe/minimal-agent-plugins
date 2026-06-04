import { describe, expect, test } from "bun:test"

import { isRoute, ROUTES, validateBody } from "./routes.ts"

describe("isRoute", () => {
  test("accepts known routes", () => {
    for (const r of ROUTES) expect(isRoute(r)).toBe(true)
  })
  test("rejects unknown", () => {
    expect(isRoute("explode")).toBe(false)
    expect(isRoute("")).toBe(false)
  })
})

describe("validateBody", () => {
  test("eval requires target + expr", () => {
    expect(validateBody("eval", { target: "T", expr: "1+1" })).toEqual({ target: "T", expr: "1+1" })
    expect(() => validateBody("eval", { target: "T" })).toThrow(/expr/)
    expect(() => validateBody("eval", { expr: "1" })).toThrow(/target/)
  })

  test("empty string is rejected as missing", () => {
    expect(() => validateBody("eval", { target: "", expr: "1" })).toThrow(/target/)
  })

  test("frameeval requires target + urlSub + expr", () => {
    expect(validateBody("frameeval", { target: "T", urlSub: "idmsa", expr: "x" })).toEqual({
      target: "T",
      urlSub: "idmsa",
      expr: "x",
    })
    expect(() => validateBody("frameeval", { target: "T", expr: "x" })).toThrow(/urlSub/)
  })

  test("nav requires target + url", () => {
    expect(validateBody("nav", { target: "T", url: "https://x" })).toEqual({
      target: "T",
      url: "https://x",
    })
    expect(() => validateBody("nav", { target: "T" })).toThrow(/url/)
  })

  test("newtab defaults url to about:blank", () => {
    expect(validateBody("newtab", {})).toEqual({ url: "about:blank" })
    expect(validateBody("newtab", { url: "https://x" })).toEqual({ url: "https://x" })
  })

  test("setdownload requires target + dir", () => {
    expect(validateBody("setdownload", { target: "T", dir: "/tmp/x" })).toEqual({
      target: "T",
      dir: "/tmp/x",
    })
    expect(() => validateBody("setdownload", { target: "T" })).toThrow(/dir/)
  })

  test("param-less routes return empty object", () => {
    expect(validateBody("ping", {})).toEqual({})
    expect(validateBody("targets", { junk: 1 })).toEqual({})
    expect(validateBody("downloads", {})).toEqual({})
  })

  test("send requires a Domain.method and defaults params to {}", () => {
    expect(validateBody("send", { method: "Network.enable" })).toEqual({
      method: "Network.enable",
      params: {},
      sessionId: undefined,
      target: undefined,
    })
    expect(
      validateBody("send", { method: "Network.getResponseBody", params: { requestId: "7" } }),
    ).toEqual({
      method: "Network.getResponseBody",
      params: { requestId: "7" },
      sessionId: undefined,
      target: undefined,
    })
  })

  test("send rejects a non-CDP method shape", () => {
    expect(() => validateBody("send", { method: "notamethod" })).toThrow(/CDP method/)
    expect(() => validateBody("send", { method: "lower.case" })).toThrow(/CDP method/)
    expect(() => validateBody("send", {})).toThrow(/method/)
  })

  test("send rejects non-object params", () => {
    expect(() => validateBody("send", { method: "X.y", params: [1, 2] })).toThrow(/object/)
    expect(() => validateBody("send", { method: "X.y", params: "no" })).toThrow(/object/)
  })

  test("send passes through target + sessionId when present", () => {
    expect(
      validateBody("send", { method: "DOM.getDocument", target: "T", sessionId: "S" }),
    ).toEqual({ method: "DOM.getDocument", params: {}, target: "T", sessionId: "S" })
  })

  test("events accepts optional filter/since/sessionId/limit/clear", () => {
    expect(validateBody("events", {})).toEqual({
      filter: undefined,
      since: undefined,
      sessionId: undefined,
      limit: undefined,
      clear: undefined,
    })
    expect(
      validateBody("events", { filter: "Network", since: 10, limit: 50, clear: true }),
    ).toEqual({ filter: "Network", since: 10, sessionId: undefined, limit: 50, clear: true })
  })

  test("events rejects wrong-typed fields", () => {
    expect(() => validateBody("events", { since: "10" })).toThrow(/number/)
    expect(() => validateBody("events", { clear: "yes" })).toThrow(/boolean/)
  })

  test("record defaults on to true", () => {
    expect(validateBody("record", {})).toEqual({ on: true, clear: undefined })
    expect(validateBody("record", { on: false, clear: true })).toEqual({ on: false, clear: true })
  })

  test("target-id routes require target", () => {
    for (const r of ["closetarget", "activatetarget", "getinfo"] as const) {
      expect(validateBody(r, { target: "T" })).toEqual({ target: "T" })
      expect(() => validateBody(r, {})).toThrow(/target/)
    }
  })
})
