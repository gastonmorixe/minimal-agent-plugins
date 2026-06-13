import { describe, expect, test } from "bun:test"

import { FetchError } from "../lib/errors.ts"

import { buildDisplayBody, configureSgr, fetchErrorResult, resolveSgr } from "./fetch.ts"

describe("fetch style facade", () => {
  test("uses standalone ANSI fallbacks", () => {
    expect(resolveSgr("not json").red).toBe("\x1b[31m")
    expect(buildDisplayBody("")).toBe("\x1b[2m(empty response)\x1b[22m")
  })

  test("resolves foreground tokens from host-injected palette context", () => {
    const sgr = resolveSgr(JSON.stringify({ red: "\x1b[38;5;196m", _fgReset: "\x1b[39m" }))
    expect(sgr.red).toBe("\x1b[38;5;196m")
    expect(sgr.fgReset).toBe("\x1b[39m")
    expect(sgr.dim).toBe("\x1b[2m")
  })

  test("error rendering uses the style facade wrappers", () => {
    const result = fetchErrorResult(
      new FetchError("timeout", "Fetch: timed out"),
      "https://example.com",
      "markdown",
    )
    expect(result.kind).toBe("tool_result")
    if (result.kind !== "tool_result") return
    expect(result.displayHeader).toBe("\x1b[31mhttps://example.com  timeout\x1b[39m")
    expect(result.display).toBe("\x1b[2mtimed out\x1b[22m")
    expect(result.displayFooter).toBe("\x1b[2mmarkdown\x1b[22m")
  })

  test("configured facade uses host context for error rendering", () => {
    configureSgr(JSON.stringify({ red: "\x1b[38;5;196m", _fgReset: "\x1b[39m" }))
    const result = fetchErrorResult(
      new FetchError("timeout", "Fetch: timed out"),
      "https://example.com",
      "markdown",
    )
    configureSgr(undefined)

    expect(result.kind).toBe("tool_result")
    if (result.kind !== "tool_result") return
    expect(result.displayHeader).toBe("\x1b[38;5;196mhttps://example.com  timeout\x1b[39m")
  })
})
