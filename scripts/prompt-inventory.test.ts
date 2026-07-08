import { describe, expect, test } from "bun:test"

import { collectInlineTsStrings, longestCommonRun, toWords } from "./prompt-inventory.ts"

describe("prompt-inventory pure helpers", () => {
  describe("toWords", () => {
    test("lowercases, strips markdown markers, splits on whitespace", () => {
      expect(toWords("The `Foo` **bar** #Baz")).toEqual(["the", "foo", "bar", "baz"])
    })
    test("collapses runs of whitespace and drops empties", () => {
      expect(toWords("a   b\n\nc")).toEqual(["a", "b", "c"])
    })
    test("empty input yields empty array", () => {
      expect(toWords("   ")).toEqual([])
    })
  })

  describe("longestCommonRun", () => {
    test("finds the maximal contiguous shared run", () => {
      const a = "the quick brown fox jumps".split(" ")
      const b = "a quick brown fox runs".split(" ")
      expect(longestCommonRun(a, b)).toEqual(["quick", "brown", "fox"])
    })
    test("returns empty when nothing shared", () => {
      expect(longestCommonRun(["a", "b"], ["c", "d"])).toEqual([])
    })
    test("picks the longest of multiple shared runs", () => {
      const a = "x one x aa bb cc dd".split(" ")
      const b = "y one y aa bb cc dd".split(" ")
      expect(longestCommonRun(a, b)).toEqual(["aa", "bb", "cc", "dd"])
    })
    test("handles empty arrays", () => {
      expect(longestCommonRun([], ["a"])).toEqual([])
      expect(longestCommonRun(["a"], [])).toEqual([])
    })
  })

  describe("collectInlineTsStrings", () => {
    test("extracts a systemPrompt string literal >= 25 chars", () => {
      const src = `const x = { systemPrompt: "You are a careful read-only explorer agent." }`
      const got = collectInlineTsStrings(src)
      expect(got).toHaveLength(1)
      expect(got[0].text).toContain("careful read-only explorer")
      expect(got[0].locator).toMatch(/^systemPrompt@L/)
    })
    test("joins adjacent concatenated string literals", () => {
      const src = [
        "const d = {",
        '  description: "first half of a long description that is " +',
        '    "second half continuing past the twenty-five char floor",',
        "}",
      ].join("\n")
      const got = collectInlineTsStrings(src)
      expect(got).toHaveLength(1)
      expect(got[0].text).toContain("first half")
      expect(got[0].text).toContain("second half")
    })
    test("skips trivial short literals below the prose floor", () => {
      const src = `const d = { description: "short" }`
      expect(collectInlineTsStrings(src)).toEqual([])
    })
    test("decodes escaped newlines in the literal", () => {
      const src = `const d = { systemPrompt: "line one has enough length here\\nline two also present" }`
      const got = collectInlineTsStrings(src)
      expect(got[0].text).toContain("\n")
    })
  })
})
