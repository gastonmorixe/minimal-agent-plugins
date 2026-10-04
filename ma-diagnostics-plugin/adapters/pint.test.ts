/**
 * Tests for the pint `--test --format=json` → {@link Finding}[] adapter. Feeds
 * JSON and text shapes so parsing matches production, with no spawning.
 */
import { describe, expect, it } from "bun:test"

import { adaptPint, PINT_GENERIC_MESSAGE } from "./pint.ts"

describe("adaptPint", () => {
  it("maps JSON files with appliedFixers to format findings", () => {
    const raw = JSON.stringify({
      files: [
        {
          name: "app/Models/User.php",
          appliedFixers: ["ordered_imports", "trailing_comma_in_multiline"],
        },
      ],
    })
    const out = adaptPint(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "pint",
      severity: "warning",
      code: "format",
      path: "app/Models/User.php",
      message:
        "File does not match the project's formatting rules (reported by pint): ordered_imports, trailing_comma_in_multiline.",
    })
    expect(out[0]?.message.toLowerCase()).not.toContain("run ")
    expect(out[0]?.message).not.toContain("pint --")
  })

  it("tolerates path/fixers aliases and empty fixer lists", () => {
    const raw = JSON.stringify({
      files: [{ path: "src/a.php", fixers: [] }],
    })
    const out = adaptPint(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "pint",
      path: "src/a.php",
      message: PINT_GENERIC_MESSAGE,
    })
  })

  it("yields [] for JSON with an empty files array", () => {
    expect(adaptPint(JSON.stringify({ files: [] }))).toEqual([])
  })

  it("uses the text fallback for FAIL lines with fixer ids", () => {
    const raw = [
      "  FAIL  app/Http/Kernel.php ordered_imports, trailing_comma_in_multiline",
      "  ⨯ routes/web.php",
    ].join("\n")
    const out = adaptPint(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: "pint",
      severity: "warning",
      code: "format",
      path: "app/Http/Kernel.php",
      message:
        "File does not match the project's formatting rules (reported by pint): ordered_imports, trailing_comma_in_multiline.",
    })
    expect(out[1]).toMatchObject({
      path: "routes/web.php",
      message: PINT_GENERIC_MESSAGE,
    })
  })

  it("yields [] on empty, whitespace, and garbage input", () => {
    expect(adaptPint("")).toEqual([])
    expect(adaptPint("   \n\n")).toEqual([])
    expect(adaptPint("garbage output without structure")).toEqual([])
  })

  it("extracts JSON wrapped in verbose progress text", () => {
    const body = JSON.stringify({
      files: [{ name: "app/a.php", appliedFixers: ["ordered_imports"] }],
    })
    const out = adaptPint(`Checking...\n${body}\nDone.\n`)
    expect(out).toHaveLength(1)
    expect(out[0]?.path).toBe("app/a.php")
    expect(out[0]?.message).toContain("ordered_imports")
  })

  it("appends a truncated proposed diff when present", () => {
    const diff = ["--- a", "+++ b", "-old", "+new"].join("\n")
    const out = adaptPint(
      JSON.stringify({
        files: [{ name: "app/a.php", appliedFixers: ["ordered_imports"], diff }],
      }),
    )
    expect(out[0]?.message).toContain("ordered_imports")
    expect(out[0]?.message).toContain("Expected content diff")
    expect(out[0]?.message).toContain("+new")
    expect(out[0]?.message.toLowerCase()).not.toContain("run ")
  })
})
