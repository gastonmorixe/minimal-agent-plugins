/**
 * Drift: every official CLI model id must resolve in the Cursor static registry.
 * Fixture: cursor-agent models list from CLI build 2026.09.28-64d2043.
 * Refresh: `cursor-agent models > __fixtures__/cursor-cli-models.YYYY.MM.DD.txt`
 * then update the path below (see README "Refresh model registry").
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

import { registerCursorModels } from "./models.ts"

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/cursor-cli-models.2026.09.28.txt",
)

function parseCliModelIds(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes(" - ") && !line.startsWith("Available"))
    .map((line) => line.split(" - ")[0]!.trim())
    .filter(Boolean)
}

describe("cursor CLI model drift", () => {
  test("every CLI model id resolves in the static registry", () => {
    const seen = new Map<string, { id: string; vendorIds?: { cursor?: string } }>()
    registerCursorModels({
      register(m: { id: string; vendorIds?: { cursor?: string } }) {
        seen.set(m.id, m)
      },
      setDefault() {},
    } as never)

    const wire = new Set<string>()
    for (const m of seen.values()) {
      wire.add(m.id)
      wire.add(m.id.replace(/^cursor-/, ""))
      const v = m.vendorIds?.cursor
      if (v) {
        wire.add(v)
        wire.add(v.replace(/^cursor-/, ""))
      }
    }

    const cli = parseCliModelIds(readFileSync(fixturePath, "utf8"))
    expect(cli.length).toBeGreaterThan(200)

    const missing = cli.filter((id) => !wire.has(id) && !wire.has(`cursor-${id}`))
    expect(missing).toEqual([])
  })
})
