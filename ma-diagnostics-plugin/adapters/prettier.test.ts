/**
 * Tests for the prettier `--check` → {@link Finding}[] adapter. We feed REAL
 * captured output shapes (prettier 3.x) so parsing matches production, with
 * no spawning.
 */
import { describe, expect, it } from "bun:test"

import { adaptPrettier, PRETTIER_GENERIC_MESSAGE } from "./prettier.ts"

describe("adaptPrettier", () => {
  it("maps each [warn] <path> line to one finding", () => {
    const out = adaptPrettier(["[warn] src/a.ts", "[warn] src/deep/b.tsx", ""].join("\n"))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: "prettier",
      severity: "warning",
      code: "format",
      path: "src/a.ts",
      message: PRETTIER_GENERIC_MESSAGE,
    })
    expect(out[1]?.path).toBe("src/deep/b.tsx")
  })

  it("uses the exact generic message with no command suggestion", () => {
    const [f] = adaptPrettier("[warn] src/x.ts\n")
    expect(f?.message).toBe(
      "File does not match the project's formatting rules (reported by prettier).",
    )
    expect(f?.message).not.toContain("prettier --write")
    expect(f?.message.toLowerCase()).not.toContain("run ")
  })

  it("skips the summary line and non-warn lines", () => {
    const raw = [
      "[warn] src/a.ts",
      "[warn] Code style issues found in the above file(s). Fix with `--write`? No advice here.",
      "checking formatting...",
      "All matched files use Prettier code style!",
    ].join("\n")
    const out = adaptPrettier(raw)
    expect(out).toHaveLength(1)
    expect(out[0]?.path).toBe("src/a.ts")
  })

  it("yields [] for a clean run (no warn lines)", () => {
    expect(
      adaptPrettier("Checking formatting...\nAll matched files use Prettier code style!\n"),
    ).toEqual([])
  })

  it("yields [] on empty, whitespace, and garbage input", () => {
    expect(adaptPrettier("")).toEqual([])
    expect(adaptPrettier("   \n\n")).toEqual([])
    expect(adaptPrettier("garbage output without structure")).toEqual([])
  })

  it("tolerates CRLF line endings", () => {
    const out = adaptPrettier("[warn] src/crlf.ts\r\n")
    expect(out).toHaveLength(1)
    expect(out[0]?.path).toBe("src/crlf.ts")
  })
})
