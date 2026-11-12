/** Old compacted session fixtures (no `meta` key on the compact row) must still load. */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { loadSessionFromText } from "@minimal-agent/core/host/session-restore"

const DIR = join(import.meta.dir, "fixtures")

const CASES = [
  { file: "old-compacted-tail.jsonl", marker: 'kind="tail"' },
  { file: "old-compacted-local.jsonl", marker: 'kind="local"' },
]

const textOf = (m: { content: unknown }): string => JSON.stringify(m.content).replaceAll("\\", "")

describe("old compacted fixtures", () => {
  for (const { file, marker } of CASES) {
    test(`${file} has a compact row without meta`, () => {
      const rows = readFileSync(join(DIR, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      const compact = rows.filter((r) => r.kind === "compact")
      expect(compact).toHaveLength(1)
      expect("meta" in (compact[0] ?? {})).toBe(false)
    })

    test(`${file} loads with the checkpoint message`, () => {
      const loaded = loadSessionFromText(readFileSync(join(DIR, file), "utf8"))
      expect(loaded.messages.length).toBeGreaterThanOrEqual(3)
      expect(loaded.messages.some((m) => textOf(m).includes(marker))).toBe(true)
    })
  }
})
