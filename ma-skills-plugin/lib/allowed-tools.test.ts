/**
 * Tests for the `allowed-tools` tokenizer.
 *
 * @module lib/allowed-tools.test
 */

import { describe, expect, test } from "bun:test"
import { formatAllowedTools, parseAllowedTools, parseToken } from "./allowed-tools.ts"

describe("parseToken", () => {
  test("bare tool name", () => {
    expect(parseToken("Read")).toEqual({ tool: "Read", raw: "Read" })
  })

  test("tool with constraint", () => {
    expect(parseToken("Bash(git:*)")).toEqual({
      tool: "Bash",
      constraint: "git:*",
      raw: "Bash(git:*)",
    })
  })

  test("constraint with parens-like content", () => {
    expect(parseToken("Bash(echo (hi))")).toEqual({
      tool: "Bash",
      constraint: "echo (hi)",
      raw: "Bash(echo (hi))",
    })
  })

  test("empty constraint preserved", () => {
    expect(parseToken("Bash()")).toEqual({
      tool: "Bash",
      constraint: "",
      raw: "Bash()",
    })
  })

  test("unclosed paren → malformed, no constraint", () => {
    expect(parseToken("Bash(unclosed")).toEqual({
      tool: "Bash(unclosed",
      raw: "Bash(unclosed",
    })
  })

  test("leading paren → malformed", () => {
    expect(parseToken("(weird)")).toEqual({
      tool: "(weird)",
      raw: "(weird)",
    })
  })
})

describe("parseAllowedTools", () => {
  test("empty string → empty array", () => {
    expect(parseAllowedTools("")).toEqual([])
    expect(parseAllowedTools("   ")).toEqual([])
  })

  test("single bare", () => {
    expect(parseAllowedTools("Read")).toEqual([{ tool: "Read", raw: "Read" }])
  })

  test("spec example: Bash(git:*) Bash(jq:*) Read", () => {
    const r = parseAllowedTools("Bash(git:*) Bash(jq:*) Read")
    expect(r).toEqual([
      { tool: "Bash", constraint: "git:*", raw: "Bash(git:*)" },
      { tool: "Bash", constraint: "jq:*", raw: "Bash(jq:*)" },
      { tool: "Read", raw: "Read" },
    ])
  })

  test("tabs and multi-space whitespace tolerated", () => {
    const r = parseAllowedTools("Read\tWrite   Edit")
    expect(r.map((e) => e.tool)).toEqual(["Read", "Write", "Edit"])
  })

  test("mixed malformed + good tokens", () => {
    const r = parseAllowedTools("Read Bash(unclosed Write")
    expect(r).toHaveLength(3)
    expect(r[0].tool).toBe("Read")
    expect(r[1]).toEqual({ tool: "Bash(unclosed", raw: "Bash(unclosed" })
    expect(r[2].tool).toBe("Write")
  })
})

describe("formatAllowedTools", () => {
  test("round-trips via raw form", () => {
    const src = "Bash(git:*) Bash(jq:*) Read"
    expect(formatAllowedTools(parseAllowedTools(src))).toBe(src)
  })

  test("empty array → empty string", () => {
    expect(formatAllowedTools([])).toBe("")
  })
})
