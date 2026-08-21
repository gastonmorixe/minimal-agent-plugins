import { describe, expect, it } from "bun:test"

import { formatDiff } from "./format-diff.ts"

describe("formatDiff", () => {
  it("returns null for identical text", () => {
    expect(formatDiff("const x = 1\n", "const x = 1\n")).toBeNull()
  })

  it("returns null when only the trailing newline differs (same lines)", () => {
    expect(formatDiff("a\nb\n", "a\nb")).toBeNull()
  })

  it("diffs a mid-file change with one line of context each side", () => {
    const before = "const x=1\nconst y=2\nconst z=3\n"
    const after = "const x=1\nconst y = 2\nconst z=3\n"
    const d = formatDiff(before, after)
    // startLine is 1-based and includes leading context: line 2 here.
    expect(d?.startLine).toBe(1)
    expect(d?.lines).toEqual([" const x=1", "-const y=2", "+const y = 2", " const z=3"])
  })

  it("diffs an insertion without inventing a removed line", () => {
    const d = formatDiff("a\nb\nc\n", "a\nb\nX\nc\n")
    expect(d?.lines).toEqual([" b", "+X", " c"])
  })

  it("diffs a deletion without inventing an added line", () => {
    const d = formatDiff("a\nb\nc\n", "a\nc\n")
    expect(d?.startLine).toBe(1)
    expect(d?.lines).toEqual([" a", "-b", " c"])
  })

  it("clamps context at the file head", () => {
    const d = formatDiff("bad=1\ngood=2\n", "good = 1\ngood=2\n")
    expect(d?.startLine).toBe(1)
    expect(d?.lines[0]).toBe("-bad=1")
  })

  it("normalizes CRLF before comparing", () => {
    expect(formatDiff("a\r\nb\r\n", "a\r\nb\n")).toBeNull()
  })
})
