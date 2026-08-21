/**
 * Tests for {@link adaptEslint}: parse `eslint --format json` into Findings.
 */
import { describe, expect, it } from "bun:test"

import { adaptEslint } from "./eslint.ts"

describe("adaptEslint", () => {
  it("returns [] for clean output (no messages)", () => {
    const out = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [],
        suppressedMessages: [],
        errorCount: 0,
        warningCount: 0,
      },
    ])
    expect(adaptEslint(out)).toEqual([])
  })

  it("maps a single error message", () => {
    const out = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            line: 10,
            column: 5,
            endLine: 10,
            endColumn: 6,
            message: "'x' is assigned a value but never used.",
          },
        ],
        errorCount: 1,
        warningCount: 0,
      },
    ])
    const findings = adaptEslint(out)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      source: "eslint",
      severity: "error",
      line: 10,
      col: 5,
      code: "no-unused-vars",
      message: "'x' is assigned a value but never used.",
      path: "/repo/src/a.ts",
    })
  })

  it("maps severity 1 to warning", () => {
    const out = JSON.stringify([
      {
        filePath: "/repo/src/b.ts",
        messages: [
          { ruleId: "eqeqeq", severity: 1, line: 3, column: 1, message: "Expected '==='." },
        ],
      },
    ])
    const findings = adaptEslint(out)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].code).toBe("eqeqeq")
  })

  it('labels null ruleId (parse errors) as code "syntax"', () => {
    const out = JSON.stringify([
      {
        filePath: "/repo/src/c.ts",
        messages: [
          {
            ruleId: null,
            severity: 2,
            line: 1,
            column: 9,
            message: "Parsing error: Unexpected token",
          },
        ],
        fatalErrorCount: 1,
      },
    ])
    const findings = adaptEslint(out)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe("syntax")
    expect(findings[0].severity).toBe("error")
  })

  it("flattens messages from multiple file records", () => {
    const out = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { ruleId: "r1", severity: 2, line: 1, column: 1, message: "a-one" },
          { ruleId: "r2", severity: 1, line: 2, column: 3, message: "a-two" },
        ],
      },
      {
        filePath: "/repo/src/b.ts",
        messages: [{ ruleId: "r3", severity: 2, line: 7, column: 2, message: "b-one" }],
      },
    ])
    const findings = adaptEslint(out)
    expect(findings).toHaveLength(3)
    expect(findings.map((f) => f.message)).toEqual(["a-one", "a-two", "b-one"])
    expect(findings[2].path).toBe("/repo/src/b.ts")
  })

  it("returns [] for malformed JSON", () => {
    expect(adaptEslint("not json at all {")).toEqual([])
  })

  it("returns [] for empty input", () => {
    expect(adaptEslint("")).toEqual([])
  })

  it("returns [] when JSON is not an array", () => {
    expect(adaptEslint(JSON.stringify({ error: "boom" }))).toEqual([])
  })

  it("skips records without a messages array", () => {
    const out = JSON.stringify([
      { filePath: "/repo/src/x.ts" },
      { filePath: "/repo/src/y.ts", messages: [] },
    ])
    expect(adaptEslint(out)).toEqual([])
  })
})
