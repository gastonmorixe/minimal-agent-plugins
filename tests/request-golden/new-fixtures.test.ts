/** New compacted fixtures (with `meta`) must restore to the same messages as the old twins. */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { loadSessionFromText } from "@minimal-agent/core/host/session-restore"

import { GOLDEN_DIR } from "./harness.ts"

const DIR = join(import.meta.dir, "fixtures")
const read = (file: string) => readFileSync(join(DIR, file), "utf8")

const compactRow = (file: string): Record<string, unknown> => {
  const rows = read(file)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const found = rows.filter((r) => r.kind === "compact")
  expect(found).toHaveLength(1)
  return found[0] as Record<string, unknown>
}

describe("new compacted fixtures", () => {
  for (const kind of ["tail", "local"] as const) {
    test(`new-compacted-${kind} has a meta key and ts equals meta.at`, () => {
      const row = compactRow(`new-compacted-${kind}.jsonl`)
      const meta = row.meta as Record<string, unknown>
      expect(meta.kind).toBe(kind)
      expect(meta.retained).toBe(2)
      expect(meta.at).toBe(row.ts)
    })

    test(`old and new ${kind} twins restore to equal messages`, () => {
      const oldLoaded = loadSessionFromText(read(`old-compacted-${kind}.jsonl`))
      const newLoaded = loadSessionFromText(read(`new-compacted-${kind}.jsonl`))
      expect(newLoaded.messages.length).toBeGreaterThanOrEqual(3)
      expect(newLoaded.messages).toEqual(oldLoaded.messages)
    })

    test(`resume goldens of the old and new ${kind} twins are byte equal`, () => {
      const a = readFileSync(join(GOLDEN_DIR, `resume-old-compacted-${kind}.json`), "utf8")
      const b = readFileSync(join(GOLDEN_DIR, `resume-new-compacted-${kind}.json`), "utf8")
      // Only the scenario name differs.
      const norm = (s: string, n: string) => s.replace(`resume-${n}-compacted-${kind}`, "X")
      expect(norm(b, "new")).toBe(norm(a, "old"))
    })
  }
})
