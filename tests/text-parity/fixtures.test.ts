// The text-parity fixtures come from minimal-agent-core/scripts/capture-text-fixtures.ts.
// This test only checks that they parse and hold data, so the plugin parity tests have a stable base.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

const DIR = join(import.meta.dir, "fixtures")

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, unknown>
}

describe("text-parity fixtures", () => {
  test("tools.json holds the tool definitions bytes and a text map", () => {
    const f = load("tools.json")
    expect(typeof f.toolDefinitionsJson).toBe("string")
    const defs = JSON.parse(f.toolDefinitionsJson as string) as unknown[]
    expect(defs.length).toBeGreaterThan(0)
    expect(Object.keys(f.tools as object).length).toBe(defs.length)
  })

  test("system.json holds the identity and the full fact grid", () => {
    const f = load("system.json")
    expect((f.identity as string).length).toBeGreaterThan(0)
    expect((f.instructionsTemplate as string).length).toBeGreaterThan(0)
    expect((f.grid as unknown[]).length).toBe(8)
  })

  test("synthetic.json holds entries with cases and text", () => {
    const f = load("synthetic.json")
    const entries = f.entries as Array<{ fn: string; cases: Array<{ text: string }> }>
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.cases.length).toBeGreaterThan(0)
      for (const c of e.cases) expect(typeof c.text).toBe("string")
    }
  })
})
