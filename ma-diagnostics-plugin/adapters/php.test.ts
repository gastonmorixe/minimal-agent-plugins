/**
 * Tests for the `php -l` → {@link Finding}[] adapter. Feeds real `php -l`
 * output shapes so parsing matches production, with no spawning.
 */
import { describe, expect, it } from "bun:test"

import { adaptPhp } from "./php.ts"

describe("adaptPhp", () => {
  it("maps a Parse error with path and line", () => {
    const raw = [
      'Parse error: syntax error, unexpected token ";" in /abs/path/file.php on line 12',
      "Errors parsing /abs/path/file.php",
    ].join("\n")
    const out = adaptPhp(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "php",
      severity: "error",
      code: "syntax",
      path: "/abs/path/file.php",
      line: 12,
      message: 'Parse error: syntax error, unexpected token ";" in /abs/path/file.php on line 12',
    })
    expect(out[0]?.message.toLowerCase()).not.toContain("run ")
  })

  it("maps PHP-prefixed Parse error lines", () => {
    const raw = 'PHP Parse error: syntax error, unexpected token "," in file.php on line 3\n'
    const out = adaptPhp(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "php",
      severity: "error",
      code: "syntax",
      path: "file.php",
      line: 3,
    })
    expect(out[0]?.message).toContain("PHP Parse error:")
  })

  it("maps a standalone Errors parsing line", () => {
    const out = adaptPhp("Errors parsing /abs/path/file.php\n")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "php",
      severity: "error",
      code: "syntax",
      path: "/abs/path/file.php",
      message: "Errors parsing /abs/path/file.php",
    })
    expect(out[0]?.line).toBeUndefined()
  })

  it("yields [] for clean No syntax errors output", () => {
    expect(adaptPhp("No syntax errors detected in /abs/path/clean.php\n")).toEqual([])
  })

  it("yields [] on empty, whitespace, and garbage input", () => {
    expect(adaptPhp("")).toEqual([])
    expect(adaptPhp("   \n\n")).toEqual([])
    expect(adaptPhp("garbage output without structure")).toEqual([])
  })
})
