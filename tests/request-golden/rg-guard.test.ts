import { describe, expect, test } from "bun:test"

import { assertRgAvailable, normalizeText, RgMissingError } from "./harness"

describe("assertRgAvailable", () => {
  test("throws RgMissingError when rg is missing and needsRg is set", () => {
    expect(() => assertRgAvailable({ name: "s1", needsRg: true }, () => null)).toThrow(
      RgMissingError,
    )
    try {
      assertRgAvailable({ name: "s1", needsRg: true }, () => null)
    } catch (e) {
      expect((e as RgMissingError).kind).toBe("RgMissingError")
      expect((e as RgMissingError).scenario).toBe("s1")
    }
  })
  test("does nothing without needsRg", () => {
    expect(() => assertRgAvailable({ name: "s2" }, () => null)).not.toThrow()
  })
  test("does not throw when rg is found", () => {
    expect(() =>
      assertRgAvailable({ name: "s3", needsRg: true }, () => "/usr/bin/rg"),
    ).not.toThrow()
  })
})

describe("normalizeText Grep error", () => {
  test("masks rg stderr and keeps the prefix", () => {
    const input = "Grep error: regex parse error:\n    (a\nerror: unclosed group\n(rg 14.1.0)"
    expect(normalizeText(input, [])).toBe("Grep error: <RG_STDERR>")
  })
  test("leaves other text unchanged", () => {
    expect(normalizeText("No matches found", [])).toBe("No matches found")
  })
})
