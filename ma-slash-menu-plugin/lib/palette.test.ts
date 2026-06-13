import { describe, expect, it } from "bun:test"

import { resolveSgr, stripSgr, truncateVisible, visualWidth, wrap } from "./palette.ts"

describe("slash-menu palette facade", () => {
  it("uses host-injected palette tokens when present", () => {
    const sgr = resolveSgr(
      JSON.stringify({
        _reset: "\x1b[0m",
        _fgReset: "\x1b[39m",
        pink: "\x1b[35m",
        lime: "\x1b[32m",
        sky: "\x1b[36m",
        gold: "\x1b[33m",
        red: "\x1b[31m",
        brightRed: "\x1b[91m",
      }),
    )

    expect(sgr.pink).toBe("\x1b[35m")
    expect(sgr.boldSky).toBe("\x1b[1m\x1b[36m")
    expect(sgr.dimLime).toBe("\x1b[2m\x1b[32m")
  })

  it("falls back cleanly when palette env is missing or malformed", () => {
    expect(resolveSgr(undefined).pink).toBe("\x1b[38;5;199m")
    expect(resolveSgr("{nope").pink).toBe("\x1b[38;5;199m")
  })

  it("centralizes ANSI strip, width, wrap, and clamp helpers", () => {
    const styled = wrap("abcdef", "\x1b[31m")
    expect(stripSgr(styled)).toBe("abcdef")
    expect(visualWidth(styled)).toBe(6)
    expect(stripSgr(truncateVisible(styled, 3))).toBe("abc")
  })
})
