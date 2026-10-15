import { describe, expect, test } from "bun:test"

import { parseJsonc, stripJsonc } from "./jsonc.ts"

describe("stripJsonc", () => {
  test("removes line comments", () => {
    expect(parseJsonc('{"a": 1 // note\n}')).toEqual({ a: 1 })
  })

  test("removes block comments", () => {
    expect(parseJsonc('{/* x */"a": /* y\n z */ 2}')).toEqual({ a: 2 })
  })

  test("removes trailing commas in objects and arrays", () => {
    expect(parseJsonc('{"a": [1, 2, ], "b": {"c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } })
  })

  test("trailing comma before a comment and newline", () => {
    expect(parseJsonc('{"a": 1, // last\n}')).toEqual({ a: 1 })
  })

  test("keeps comment markers inside strings", () => {
    expect(parseJsonc('{"url": "http://example.com/*x*/", "s": "a,}"}')).toEqual({
      url: "http://example.com/*x*/",
      s: "a,}",
    })
  })

  test("keeps escaped quotes inside strings", () => {
    expect(parseJsonc('{"q": "say \\"hi\\" // no"}')).toEqual({ q: 'say "hi" // no' })
  })

  test("unterminated block comment is dropped to the end", () => {
    expect(stripJsonc('{"a": 1} /* open')).toBe('{"a": 1} ')
  })
})

describe("parseJsonc", () => {
  test("returns undefined on bad input and never throws", () => {
    expect(parseJsonc("{bad")).toBeUndefined()
    expect(parseJsonc("")).toBeUndefined()
  })

  test("parses plain JSON unchanged", () => {
    expect(parseJsonc('{"profile":"steer"}')).toEqual({ profile: "steer" })
  })
})
