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

describe("renderArrivalLines bare-row contract (host frames per-row)", () => {
  // The host's renderCommandNoticeBlock prefixes a "│ " gutter to EACH row it
  // receives and wraps to terminal width itself. That only holds if every row we
  // hand it is a single physical line: an embedded "\n" would slip past the
  // per-row gutter and tear the frame (the row after the newline gets no gutter).
  // And we must never emit our own frame glyphs — the host owns the chrome.

  test("every row is a single physical line (no embedded newline)", () => {
    const rows = renderArrivalLines([
      env({ body: "line one\nline two\nline three" }),
      env({ id: "b", body: "second message\nwith its own break" }),
    ])
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r).not.toContain("\n")
      expect(r).not.toContain("\r")
    }
  })

  test("a multi-line body is split into one row per source line", () => {
    const rows = renderArrivalLines([env({ body: "a\nb\nc" })]).map(noAnsi)
    // header row + 3 body rows
    expect(rows).toContain("a")
    expect(rows).toContain("b")
    expect(rows).toContain("c")
  })

  test("no row carries a frame glyph (╭ │ ╰) — host draws the box", () => {
    const rows = renderArrivalLines([
      env({ kind: "interrupt", body: "x\ny" }),
      env({ id: "b", body: "z" }),
    ])
    for (const r of rows) {
      expect(r).not.toContain("╭")
      expect(r).not.toContain("│")
      expect(r).not.toContain("╰")
    }
  })

  test("a very long unbreakable token stays one row (host hard-breaks at render)", () => {
    // The plugin must NOT pre-wrap: it can't know the reader's width. A 200-char
    // path with no spaces stays a single row here; the host wordWrap hard-breaks
    // it (and re-gutters each fragment) at paint time.
    const longTok = `/Users/x/${"a".repeat(200)}/sid.blobs/id.raw`
    const rows = renderArrivalLines([env({ body: longTok })])
    const bodyRows = rows.filter((r) => noAnsi(r).includes("a".repeat(50)))
    expect(bodyRows.length).toBe(1)
    expect(bodyRows[0]).not.toContain("\n")
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
