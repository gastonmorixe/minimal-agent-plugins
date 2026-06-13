import { describe, expect, test } from "bun:test"

import {
  clip,
  clipEnd,
  configureSgr,
  describeRequest,
  isErrorBody,
  renderContent,
  renderDisplay,
  resolveSgr,
  shortId,
  summarize,
} from "./render.ts"

// Strip ANSI so assertions read against plain text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes
const noAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("style facade", () => {
  test("uses standalone ANSI fallbacks", () => {
    expect(resolveSgr("not json").red).toBe("\x1b[31m")
    expect(resolveSgr("not json").gray).toBe("\x1b[90m")
  })

  test("resolves foreground tokens from host-injected palette context", () => {
    const sgr = resolveSgr(
      JSON.stringify({
        red: "\x1b[38;5;196m",
        green: "\x1b[38;5;118m",
        yellow: "\x1b[38;5;214m",
        cyan: "\x1b[38;5;45m",
        gray: "\x1b[38;5;246m",
        _fgReset: "\x1b[39m",
      }),
    )
    expect(sgr.red).toBe("\x1b[38;5;196m")
    expect(sgr.green).toBe("\x1b[38;5;118m")
    expect(sgr.yellow).toBe("\x1b[38;5;214m")
    expect(sgr.cyan).toBe("\x1b[38;5;45m")
    expect(sgr.gray).toBe("\x1b[38;5;246m")
    expect(sgr.fgReset).toBe("\x1b[39m")
  })

  test("configured facade uses host context for rendered strings", () => {
    configureSgr(JSON.stringify({ red: "\x1b[38;5;196m", _fgReset: "\x1b[39m" }))
    expect(renderDisplay("eval", { target: "T", expr: "x" }, { error: "kaboom" })).toContain(
      "\x1b[38;5;196m",
    )
    configureSgr(undefined)
  })
})

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

describe("string helpers", () => {
  test("clip collapses whitespace and ellipsizes", () => {
    expect(clip("a\n  b   c", 80)).toBe("a b c")
    expect(clip("abcdefghij", 5)).toBe("abcd…")
  })
  test("clipEnd preserves internal whitespace", () => {
    expect(clipEnd("a  b\n  c", 80)).toBe("a  b\n  c")
    expect(clipEnd("abcdef", 4)).toBe("abc…")
  })
  test("shortId only shortens long ids", () => {
    expect(shortId("ABC")).toBe("ABC")
    expect(noAnsi(shortId("6A21F2A0DEADBEEF0123456789"))).toBe("6A21F2A0D…6789")
  })
})

describe("describeRequest", () => {
  test("eval shows the tab and the JS expression", () => {
    const h = noAnsi(describeRequest("eval", { target: "TAB123456789", expr: "document.cookie" }))
    expect(h).toContain("eval")
    expect(h).toContain("document.cookie")
  })
  test("eval collapses multi-line JS to one line", () => {
    const h = noAnsi(describeRequest("eval", { target: "T", expr: "const a=1;\na+2" }))
    expect(h).not.toContain("\n")
    expect(h).toContain("const a=1; a+2")
  })
  test("send shows the CDP method and compact params", () => {
    const h = noAnsi(
      describeRequest("send", { method: "Network.getResponseBody", params: { requestId: "42.7" } }),
    )
    expect(h).toContain("send")
    expect(h).toContain("Network.getResponseBody")
    expect(h).toContain('"requestId":"42.7"')
  })
  test("send with no params omits the params chunk", () => {
    const h = noAnsi(describeRequest("send", { method: "Page.enable", params: {} }))
    expect(h).toContain("Page.enable")
    expect(h).not.toContain("{")
  })
  test("nav shows the destination url", () => {
    const h = noAnsi(describeRequest("nav", { target: "T", url: "https://example.com/x" }))
    expect(h).toContain("nav")
    expect(h).toContain("https://example.com/x")
  })
  test("record reflects on/off", () => {
    expect(noAnsi(describeRequest("record", { on: true }))).toContain("on")
    expect(noAnsi(describeRequest("record", { on: false }))).toContain("off")
  })
  test("argless routes are just the action name", () => {
    expect(noAnsi(describeRequest("targets", {}))).toBe("targets")
    expect(noAnsi(describeRequest("ping", {}))).toBe("ping")
  })
})

describe("renderDisplay", () => {
  test("eval body shows the expression and a result preview", () => {
    const body = noAnsi(renderDisplay("eval", { target: "T", expr: "1+2" }, { result: 3 }))
    expect(body).toContain("❯ 1+2")
    expect(body).toContain("result")
    expect(body).toContain("3")
  })
  test("eval error surfaces the __error message, not a result", () => {
    const body = noAnsi(
      renderDisplay(
        "eval",
        { target: "T", expr: "boom()" },
        { result: { __error: "ReferenceError: boom" } },
      ),
    )
    expect(body).toContain("❯ boom()")
    expect(body).toContain("ReferenceError: boom")
    expect(body).not.toContain("⤷")
  })
  test("send body shows method, scope, and params", () => {
    const body = noAnsi(
      renderDisplay(
        "send",
        { method: "Network.getResponseBody", params: { requestId: "9.1" }, target: "TAB" },
        { result: { body: "…" } },
      ),
    )
    expect(body).toContain("Network.getResponseBody")
    expect(body).toContain("scope")
    expect(body).toContain("tab TAB")
    expect(body).toContain("requestId")
  })
  test("send with no target reports browser-global scope", () => {
    const body = noAnsi(renderDisplay("send", { method: "Browser.getVersion", params: {} }, {}))
    expect(body).toContain("browser-global")
  })
  test("nav body shows the destination", () => {
    const body = noAnsi(renderDisplay("nav", { target: "T", url: "https://a.test" }, { ok: true }))
    expect(body).toContain("→ https://a.test")
  })
  test("daemon error body renders an error line", () => {
    const body = noAnsi(renderDisplay("eval", { target: "T", expr: "x" }, { error: "kaboom" }))
    expect(body).toContain("kaboom")
  })
  test("targets body previews the returned array", () => {
    const body = noAnsi(renderDisplay("targets", {}, [{ id: "A", url: "https://a" }]))
    expect(body).toContain("list open page tabs")
    expect(body).toContain("https://a")
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
