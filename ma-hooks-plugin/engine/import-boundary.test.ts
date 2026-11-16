/**
 * Import boundary (SPEC.md "Dependency rule"): adapters depend on the engine
 * only, native never imports an adapter, and only `engine/registry.ts` knows
 * the concrete dialects. Static `import`/`export ... from` and dynamic
 * `import()` are checked. Test files are excluded: engine tests drive the
 * native adapter on purpose (`engine/engine.test.ts`, `engine/units.test.ts`).
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import { describe, expect, test } from "bun:test"

const ROOT = resolve(import.meta.dir, "..")

/** Every import specifier in a TS source text. */
export function importSpecifiers(text: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) if (m[1]) out.push(m[1])
  }
  return out
}

/** Top area of a plugin-relative path: `adapters/<x>`, `native`, `engine`, or other. */
function area(rel: string): string {
  const parts = rel.split(sep)
  if (parts[0] === "adapters" && parts[1]) return `adapters/${parts[1]}`
  return parts[0] ?? ""
}

/** Boundary violations of one file (plugin-relative path plus its text). */
export function violations(rel: string, text: string): string[] {
  const from = area(rel)
  const bad: string[] = []
  for (const spec of importSpecifiers(text)) {
    if (!spec.startsWith(".")) continue
    const target = relative(ROOT, resolve(ROOT, dirname(rel), spec))
    const to = area(target)
    if (to === from) continue
    const toDialect = to.startsWith("adapters/") || to === "native"
    let ok = true
    if (from.startsWith("adapters/") && toDialect) ok = false
    if (from === "native" && to.startsWith("adapters/")) ok = false
    if (from === "engine" && toDialect && rel !== join("engine", "registry.ts")) ok = false
    if (!ok) bad.push(`${rel} imports ${spec}`)
  }
  return bad
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(rel)
  }
  return out
}

describe("import boundary", () => {
  test("adapters, native and engine keep the dependency rule", () => {
    const files = ["adapters", "native", "engine"].flatMap(sources)
    expect(files).toContain(join("engine", "registry.ts"))
    const bad = files.flatMap((f) => violations(f, readFileSync(join(ROOT, f), "utf8")))
    expect(bad).toEqual([])
  })

  test("the check finds fake violations in string fixtures", () => {
    const claude = join("adapters", "claude", "x.ts")
    expect(violations(claude, `import { a } from "../codex/adapter.ts"`)).toHaveLength(1)
    expect(violations(claude, `export * from "../../native/adapter.ts"`)).toHaveLength(1)
    expect(violations(claude, `const m = await import("../../native/adapter.ts")`)).toHaveLength(1)
    expect(violations(claude, `import type { T } from "../../engine/types.ts"`)).toEqual([])
    expect(violations(claude, `import { e } from "./events.ts"`)).toEqual([])
    const native = join("native", "adapter.ts")
    expect(violations(native, `import "../adapters/claude/adapter.ts"`)).toHaveLength(1)
    const engine = join("engine", "engine.ts")
    expect(violations(engine, `import { n } from "../native/adapter.ts"`)).toHaveLength(1)
    expect(violations(engine, `export { c } from "../adapters/claude/adapter.ts"`)).toHaveLength(1)
    const registry = join("engine", "registry.ts")
    expect(violations(registry, `import { n } from "../native/adapter.ts"`)).toEqual([])
  })
})
