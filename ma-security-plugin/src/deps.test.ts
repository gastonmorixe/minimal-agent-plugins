/**
 * Zero runtime dependency guard. The plugin must load with no install step,
 * so package.json has no `dependencies` and no source file imports a bare
 * module other than `node:*`, `bun`, or `bun:*`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { importSpecifiers, listSourceFiles, PLUGIN_ROOT } from "./test-support.ts"

function isAllowedSpecifier(spec: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) return true
  if (spec.startsWith("node:")) return true
  return spec === "bun" || spec.startsWith("bun:")
}

describe("dependencies", () => {
  test("package.json has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >
    const deps = pkg.dependencies
    if (deps !== undefined) expect(Object.keys(deps as object)).toEqual([])
    expect(pkg.peerDependencies).toBeUndefined()
    expect(pkg.optionalDependencies).toBeUndefined()
  })

  test("every import is relative, node:, or bun", () => {
    const bad: string[] = []
    for (const file of listSourceFiles({ includeTests: true })) {
      const text = readFileSync(file, "utf8")
      for (const spec of importSpecifiers(text)) {
        if (!isAllowedSpecifier(spec)) bad.push(`${file}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  test("import scan catches every form", () => {
    // Keywords are split so this file's own scan does not see the mutants.
    const imp = ["imp", "ort"].join("")
    const req = ["requ", "ire"].join("")
    const text = [
      `${imp} a from "dep-a"`,
      `export { b } from "dep-b"`,
      `const c = await ${imp}("dep-c")`,
      `${imp} "dep-d"`,
      `const e = ${req}("dep-e")`,
      `const f = ${req}( 'dep-f' )`,
    ].join("\n")
    expect(importSpecifiers(text).sort()).toEqual([
      "dep-a",
      "dep-b",
      "dep-c",
      "dep-d",
      "dep-e",
      "dep-f",
    ])
  })

  test("the scan finds the entry and source files", () => {
    const files = listSourceFiles({ includeTests: false }).map((f) =>
      f.slice(PLUGIN_ROOT.length + 1),
    )
    expect(files).toContain("index.ts")
    expect(files).toContain(join("src", "jsonc.ts"))
  })
})
