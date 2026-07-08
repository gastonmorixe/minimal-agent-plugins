import { describe, expect, test } from "bun:test"

import { parseArgs, sanitize } from "./sanitize-prompts.ts"

describe("sanitize (default: reflow on)", () => {
  test("reflows wrapped paragraph lines onto one line", () => {
    expect(sanitize("a\nb\n")).toBe("a b\n")
  })
  test("collapses runs of blank lines to one", () => {
    expect(sanitize("a\n\n\n\nb\n")).toBe("a\n\nb\n")
  })
  test("drops leading blank lines", () => {
    expect(sanitize("\n\na\n")).toBe("a\n")
  })
  test("drops trailing blank lines and ensures one final newline", () => {
    expect(sanitize("a\n\n\n")).toBe("a\n")
    expect(sanitize("a")).toBe("a\n")
  })
  test("preserves single block separators", () => {
    expect(sanitize("# H\n\npara\n\n- item\n")).toBe("# H\n\npara\n\n- item\n")
  })
  test("does not merge a list item into the preceding paragraph", () => {
    expect(sanitize("para\n- item\n")).toBe("para\n- item\n")
  })
  test("empty input stays empty", () => {
    expect(sanitize("")).toBe("")
    expect(sanitize("\n\n")).toBe("")
  })
  test("already-clean file is unchanged", () => {
    const clean = "# Title\n\nA line.\n\n- a\n- b\n"
    expect(sanitize(clean)).toBe(clean)
  })
  test("preserves 4-space indented code blocks verbatim (no reflow join)", () => {
    // Regression: an indented code block (CommonMark) must not be reflowed. Two
    // example rows must stay on separate lines, not join into one corrupt line.
    const input = "intro line\n\n    row one here\n    row two here\n\nafter\n"
    expect(sanitize(input)).toBe(input)
  })
  test("preserves tab-indented code lines verbatim", () => {
    const input = "p\n\n\tcode a\n\tcode b\n\nq\n"
    expect(sanitize(input)).toBe(input)
  })
  test("still reflows wrapped prose around an indented code block", () => {
    const input = "one\ntwo\n\n    codeline\n\nthree\nfour\n"
    expect(sanitize(input)).toBe("one two\n\n    codeline\n\nthree four\n")
  })
})

describe("sanitize (--no-reflow: blank normalize only)", () => {
  const noReflow = { reflow: false }
  test("strips trailing whitespace without joining wrapped lines", () => {
    expect(sanitize("a   \nb\t\n", noReflow)).toBe("a\nb\n")
  })
  test("collapses blank runs but keeps the line break between plain lines", () => {
    expect(sanitize("a\n\n\n\nb\n", noReflow)).toBe("a\n\nb\n")
  })
})

describe("sanitize (aggressive)", () => {
  test("drops every blank line", () => {
    expect(sanitize("# H\n\npara\n\n- a\n- b\n", { aggressive: true })).toBe(
      "# H\npara\n- a\n- b\n",
    )
  })
})

describe("parseArgs", () => {
  test("flags and paths", () => {
    const o = parseArgs(["--write", "a.md", "--aggressive", "b.md"])
    expect(o.write).toBe(true)
    expect(o.aggressive).toBe(true)
    expect(o.paths).toEqual(["a.md", "b.md"])
  })
  test("defaults", () => {
    const o = parseArgs([])
    expect(o).toEqual({ write: false, aggressive: false, reflow: true, paths: [] })
  })
  test("--no-reflow turns reflow off", () => {
    const o = parseArgs(["--no-reflow", "x.md"])
    expect(o.reflow).toBe(false)
    expect(o.paths).toEqual(["x.md"])
  })
})
