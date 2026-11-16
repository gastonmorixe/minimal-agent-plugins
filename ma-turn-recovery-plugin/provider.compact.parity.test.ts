/**
 * Byte parity of the `compact.*` kinds against the old core compaction text
 * (15d.2). The fixture `tests/text-parity/fixtures/compact.json` was captured
 * from core `src/agent/context-compact.ts` (15d.0). Each case stores the facts
 * core will pass (trimmed focus, trimmed summary) and the text the kind must
 * return. The provider output must equal it byte for byte. This is a move, not
 * an STE rewrite: no text changes.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

import { createTurnRecoveryProvider } from "./provider.ts"

const FIXTURE = join(import.meta.dir, "..", "tests", "text-parity", "fixtures", "compact.json")

interface FixtureCase {
  name?: string
  args: unknown
  facts: SyntheticFacts
  text: string
  fullText?: string
}
interface FixtureEntry {
  fn: string
  proposedKind: string
  cases: FixtureCase[]
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  marker: string
  entries: FixtureEntry[]
}

const provider = createTurnRecoveryProvider()

const KINDS: readonly SyntheticKind[] = [
  "compact.summary_system",
  "compact.tail_checkpoint",
  "compact.local_checkpoint",
]

/** The tag kind core writes before a checkpoint text. */
const TAG_KIND: Partial<Record<SyntheticKind, string>> = {
  "compact.tail_checkpoint": "tail",
  "compact.local_checkpoint": "local",
}

describe("compact.* parity with the old core text (compact.json)", () => {
  it("the fixture has the 3 kinds and the provider owns them", () => {
    expect(fixture.entries.map((e) => e.proposedKind).sort()).toEqual([...KINDS].sort())
    for (const k of KINDS) expect(provider.kinds).toContain(k)
    expect(fixture.entries.reduce((n, e) => n + e.cases.length, 0)).toBe(12)
  })

  for (const e of fixture.entries) {
    const kind = e.proposedKind as SyntheticKind
    e.cases.forEach((c, i) => {
      it(`${kind} case ${c.name ?? i} (${JSON.stringify(c.facts)})`, () => {
        const out = provider.text(kind, c.facts)
        expect(out).toBe(c.text)
        expect(Buffer.from(out, "utf8").equals(Buffer.from(c.text, "utf8"))).toBe(true)
        const tag = TAG_KIND[kind]
        if (tag !== undefined) {
          expect(`${fixture.marker} kind="${tag}" />\n${out}`).toBe(c.fullText as string)
        }
      })
    })
  }
})

describe("compact.* facts", () => {
  it("an empty focus or summary string is the same as absent", () => {
    expect(provider.text("compact.summary_system", { focus: "" })).toBe(
      provider.text("compact.summary_system", {}),
    )
    expect(provider.text("compact.local_checkpoint", { focus: "", summary: "" })).toBe(
      provider.text("compact.local_checkpoint", {}),
    )
  })

  it("a missing or wrong-typed fact throws", () => {
    expect(() => provider.text("compact.tail_checkpoint", {})).toThrow()
    expect(() => provider.text("compact.tail_checkpoint", { retained: "2" })).toThrow()
    expect(() => provider.text("compact.summary_system", { focus: 1 })).toThrow()
    expect(() => provider.text("compact.local_checkpoint", { summary: true })).toThrow()
  })
})
