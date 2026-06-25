/**
 * Tests for the arrival-notice renderers. These lock the bug fix: the human
 * terminal surface must NOT html-escape peer text (the `&lt;/&gt;` regression),
 * while still stripping smuggled escape/control sequences.
 *
 * @module lib/render.test
 */

import { describe, expect, test } from "bun:test"

import type { Envelope } from "./envelope.ts"
import { arrivalLabel, renderArrivalLines, renderArrivalText } from "./render.ts"

/** Strip ANSI SGR so assertions read against plain text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertions.
const noAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "id-1",
    kind: "message",
    body: "hello",
    ts: "2026-06-25T13:00:04.805Z",
    from: { sid: "s-aaaaaa", short: "aaaaaa", model: "opus", cwd: "/x/proj" },
    to: "bbbbbb",
    scope: "bbbbbb",
    ...over,
  } as Envelope
}

describe("arrivalLabel", () => {
  test("singular vs plural", () => {
    expect(arrivalLabel(1)).toBe("1 new message")
    expect(arrivalLabel(3)).toBe("3 new messages")
  })
})

describe("renderArrivalLines (human terminal)", () => {
  test("does NOT html-escape angle brackets in the body (the &lt; bug)", () => {
    const lines = renderArrivalLines([env({ body: "use <ma::foo> and a < b > c" })]).map(noAnsi)
    const joined = lines.join("\n")
    expect(joined).toContain("use <ma::foo> and a < b > c")
    expect(joined).not.toContain("&lt;")
    expect(joined).not.toContain("&gt;")
    expect(joined).not.toContain("‹ma::")
  })

  test("returns bare rows: no box frame glyphs (host owns chrome)", () => {
    const lines = renderArrivalLines([env()])
    for (const l of lines) {
      expect(l).not.toContain("╭")
      expect(l).not.toContain("│")
      expect(l).not.toContain("╰")
    }
  })

  test("strips smuggled ANSI/control sequences from peer body", () => {
    const evil = "safe\x1b[31mRED\x1b[0m\x1b]0;title\x07tail"
    const out = noAnsi(renderArrivalLines([env({ body: evil })]).join("\n"))
    expect(out).toContain("safe")
    expect(out).toContain("RED")
    expect(out).toContain("tail")
    expect(out).not.toContain("\x1b")
    expect(out).not.toContain("\x07")
  })

  test("interrupt is marked, separates multiple messages with a blank row", () => {
    const lines = renderArrivalLines([
      env({ id: "a", kind: "interrupt", body: "first" }),
      env({ id: "b", body: "second" }),
    ]).map(noAnsi)
    expect(lines.join("\n")).toContain("INTERRUPT")
    expect(lines).toContain("")
  })
})

describe("renderArrivalText (persistence)", () => {
  test("plain, no ANSI, no html-escape, carries label + body", () => {
    const text = renderArrivalText([env({ body: "x < y" })])
    expect(text).toBe(noAnsi(text)) // already plain
    expect(text).toContain("1 new message")
    expect(text).toContain("x < y")
    expect(text).not.toContain("&lt;")
  })
})
