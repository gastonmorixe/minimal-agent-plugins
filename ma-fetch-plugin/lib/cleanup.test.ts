import { describe, expect, test } from "bun:test"

import {
  applyCleanup,
  CLEANUP_LEVELS,
  cleanupAggressive,
  cleanupBasic,
  isCleanableFormat,
} from "./cleanup.ts"

// ---------------------------------------------------------------------------
// cleanupBasic — the long-standing normalizer. Behavior must not regress.
// ---------------------------------------------------------------------------

describe("cleanupBasic", () => {
  test("empty string preserved", () => {
    expect(cleanupBasic("")).toBe("")
  })

  test("single line, no trailing newline, unchanged", () => {
    expect(cleanupBasic("hello world")).toBe("hello world")
  })

  test("rstrips trailing space + tab", () => {
    expect(cleanupBasic("foo   \nbar\t\t\nbaz")).toBe("foo\nbar\nbaz")
  })

  test("collapses runs of 2+ blank lines into a single blank", () => {
    expect(cleanupBasic("a\n\n\n\n\nb")).toBe("a\n\nb")
  })

  test("collapses runs of whitespace-only lines (after rstrip)", () => {
    expect(cleanupBasic("a\n\t\n  \n\t\t\nb")).toBe("a\n\nb")
  })

  test("strips leading + trailing blank lines", () => {
    expect(cleanupBasic("\n\n\nhello\n\n\n")).toBe("hello")
  })

  test("preserves single blank lines between content (paragraph separators)", () => {
    const md = "para 1\n\npara 2\n\npara 3"
    expect(cleanupBasic(md)).toBe(md)
  })

  test("is idempotent", () => {
    const noisy = "  \n\n\nfoo\n\n\n  \nbar  \n\n"
    const once = cleanupBasic(noisy)
    expect(cleanupBasic(once)).toBe(once)
  })

  test("does NOT touch unicode whitespace (that's aggressive's job)", () => {
    // NBSP in the middle survives basic. It also makes a "blank-looking"
    // line NOT count as blank because rstrip only removes ASCII space/tab.
    expect(cleanupBasic("a\u00a0b")).toBe("a\u00a0b")
    expect(cleanupBasic("a\n\u00a0\nb")).toBe("a\n\u00a0\nb")
  })
})

// ---------------------------------------------------------------------------
// cleanupAggressive — basic + unicode-fold + zero-width-strip + single-blank drop
// ---------------------------------------------------------------------------

describe("cleanupAggressive", () => {
  test("empty string preserved", () => {
    expect(cleanupAggressive("")).toBe("")
  })

  test("folds NBSP to ASCII space", () => {
    expect(cleanupAggressive("a\u00a0b")).toBe("a b")
  })

  test("folds the U+2000–U+200A run + narrow/medium/ideographic", () => {
    // One representative from each cluster.
    const input = "x\u2000y\u2003z\u202Fw\u3000q"
    expect(cleanupAggressive(input)).toBe("x y z w q")
  })

  test("strips zero-width chars (ZWSP, ZWJ, ZWNJ, WORD JOINER, BOM)", () => {
    expect(cleanupAggressive("a\u200Bb\u200Cc\u200Dd\u2060e\ufeff")).toBe("abcde")
  })

  test("NBSP-only line becomes blank then gets dropped", () => {
    // aggressive: NBSP→space → rstrip → blank line → all-blanks-dropped.
    expect(cleanupAggressive("a\n\u00a0\nb")).toBe("a\nb")
  })

  test("drops ALL single blank lines (paragraph separators included)", () => {
    expect(cleanupAggressive("para 1\n\npara 2\n\npara 3")).toBe("para 1\npara 2\npara 3")
  })

  test("preserves content lines verbatim (no joining, no dedupe)", () => {
    const input = "foo\n\nfoo\n\nbar"
    // Three content lines: foo / foo / bar. Blank lines drop, but the
    // two `foo` lines stay separate.
    expect(cleanupAggressive(input)).toBe("foo\nfoo\nbar")
  })

  test("is idempotent", () => {
    const noisy = "  \n\n\u00a0\nfoo  \n\n\u200bbar\u00a0\nbaz\n\n"
    const once = cleanupAggressive(noisy)
    expect(cleanupAggressive(once)).toBe(once)
  })

  test("ASCII-only input fast-path: identical result to basic + drop-blanks", () => {
    // No unicode → fast-path skips the fold loop. The output should still
    // match the slow path (cleanupBasic followed by single-blank drop).
    const input = "alpha\n\nbeta\n\n\ngamma\n"
    const expected = "alpha\nbeta\ngamma"
    expect(cleanupAggressive(input)).toBe(expected)
  })

  test("Bloomberg-shaped fixture: dense blank-line stripping", () => {
    // Synthesized from the real Bloomberg blob: one blank between every
    // content line. Expected: blank lines vanish, content order preserved.
    const fixture =
      "# Headline\n\n" +
      "By Author\n\n" +
      "May 27, 2026\n\n" +
      "- [Link 1](#)\n" +
      "- [Link 2](#)\n\n" +
      "Body paragraph here.\n"
    const out = cleanupAggressive(fixture)
    expect(out).toBe(
      "# Headline\n" +
        "By Author\n" +
        "May 27, 2026\n" +
        "- [Link 1](#)\n" +
        "- [Link 2](#)\n" +
        "Body paragraph here.",
    )
  })
})

// ---------------------------------------------------------------------------
// applyCleanup — dispatch
// ---------------------------------------------------------------------------

describe("applyCleanup", () => {
  test("off: passthrough verbatim", () => {
    const input = "  trailing  \n\n\n\nfoo\u00a0bar\n\n"
    expect(applyCleanup(input, "off")).toBe(input)
  })

  test("basic: routes to cleanupBasic", () => {
    expect(applyCleanup("a\n\n\nb", "basic")).toBe(cleanupBasic("a\n\n\nb"))
  })

  test("aggressive: routes to cleanupAggressive", () => {
    expect(applyCleanup("a\u00a0b\n\nc", "aggressive")).toBe(cleanupAggressive("a\u00a0b\n\nc"))
  })

  test("CLEANUP_LEVELS lists all the levels", () => {
    expect([...CLEANUP_LEVELS].sort()).toEqual(["aggressive", "basic", "off"])
  })
})

// ---------------------------------------------------------------------------
// isCleanableFormat — only markdown/text get the treatment
// ---------------------------------------------------------------------------

describe("isCleanableFormat", () => {
  test("markdown: yes", () => {
    expect(isCleanableFormat("markdown")).toBe(true)
  })
  test("text: yes", () => {
    expect(isCleanableFormat("text")).toBe(true)
  })
  test("html: no (newlines are syntactic in <pre>)", () => {
    expect(isCleanableFormat("html")).toBe(false)
  })
  test("links: no (one-per-line is the contract)", () => {
    expect(isCleanableFormat("links")).toBe(false)
  })
  test("accessibility: no (structured JSON)", () => {
    expect(isCleanableFormat("accessibility")).toBe(false)
  })

  test("original: no (raw byte stream)", () => {
    expect(isCleanableFormat("original")).toBe(false)
  })
})
