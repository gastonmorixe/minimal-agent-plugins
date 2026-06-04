/**
 * Tests for the minimal JSONC stripper/parser.
 *
 * The headline regression: trailing-comma elision must NOT corrupt commas
 * that appear inside string values (CSS selectors, User-Agents, eval
 * snippets), which a naive global `/,(\s*[}\]])/` post-pass would do.
 */

import { describe, expect, test } from "bun:test"

import { parseJsonc, stripJsonc } from "./jsonc.ts"

describe("stripJsonc — string safety (regression)", () => {
  test("preserves a comma-then-brace inside a string value", () => {
    expect(parseJsonc(`{"ua": "Mozilla,}x"}`)).toEqual({ ua: "Mozilla,}x" })
  })

  test("preserves a comma-then-bracket inside a string value", () => {
    expect(parseJsonc(`{"selector": "div[data-x=1,2]"}`)).toEqual({ selector: "div[data-x=1,2]" })
  })

  test("preserves trailing commas inside two adjacent strings", () => {
    expect(parseJsonc(`{"a": "x,", "b": "y,"}`)).toEqual({ a: "x,", b: "y," })
  })

  test("does not treat // or /* inside a string as a comment", () => {
    expect(parseJsonc(`{"u": "https://x//y", "g": "a/*b*/c"}`)).toEqual({
      u: "https://x//y",
      g: "a/*b*/c",
    })
  })
})

describe("stripJsonc — trailing commas still stripped", () => {
  test("object trailing comma", () => {
    expect(parseJsonc(`{"a": 1,}`)).toEqual({ a: 1 })
  })

  test("array trailing comma", () => {
    expect(parseJsonc(`{"a": [1, 2,]}`)).toEqual({ a: [1, 2] })
  })

  test("trailing comma with newlines/whitespace before brace", () => {
    expect(parseJsonc(`{\n  "a": 1,\n  "b": 2,\n}`)).toEqual({ a: 1, b: 2 })
  })

  test("nested array of objects with trailing commas", () => {
    expect(parseJsonc(`[{"a": 1,}, {"b": 2,},]`)).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe("stripJsonc — comments", () => {
  test("line comment", () => {
    expect(parseJsonc(`{"a": 1 // hi\n, "b": 2}`)).toEqual({ a: 1, b: 2 })
  })

  test("block comment between tokens", () => {
    expect(parseJsonc(`{"a": 1,/* x */ "b": 2}`)).toEqual({ a: 1, b: 2 })
  })
})

describe("stripJsonc — degenerate input", () => {
  test("empty object / array", () => {
    expect(parseJsonc(`{}`)).toEqual({})
    expect(parseJsonc(`[]`)).toEqual([])
  })

  test("a top-level trailing comma stays invalid (not silently dropped)", () => {
    // `{"a":1},` after stripping is still invalid JSON; we must not swallow
    // the comma into validity.
    expect(() => parseJsonc(`{"a": 1},`)).toThrow()
  })

  test("string spans are byte-identical through stripJsonc", () => {
    const s = `{"sel": "a,b}c]d,", "n": 1,}`
    expect(stripJsonc(s)).toContain(`"a,b}c]d,"`)
  })
})
