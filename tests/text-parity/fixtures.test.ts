// The text-parity fixtures come from minimal-agent-core/scripts/capture-text-fixtures.ts.
// compact.json comes from tests/text-parity/capture-compact.ts (15d.0, history only).
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
    expect((f.grid as unknown[]).length).toBe(2)
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

  test("compact.json holds the 3 compaction kinds and matches the summary golden", () => {
    const f = load("compact.json")
    const entries = f.entries as Array<{
      proposedKind: string
      cases: Array<{ facts: Record<string, unknown>; text: string; fullText?: string }>
    }>
    expect(entries.map((e) => e.proposedKind)).toEqual([
      "compact.summary_system",
      "compact.tail_checkpoint",
      "compact.local_checkpoint",
    ])
    for (const e of entries) {
      expect(e.cases.length).toBeGreaterThan(0)
      for (const c of e.cases) {
        expect(c.text.length).toBeGreaterThan(0)
        if (c.fullText !== undefined) expect(c.fullText.endsWith(c.text)).toBe(true)
      }
    }
    // The summary request goldens (15d.0, 15d0b) carry the same bytes as the fixture.
    type Golden = {
      requests: Array<{
        system: Array<{ type: string; text: string }>
        messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>
      }>
    }
    const loadGolden = (name: string): Golden =>
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "..", "request-golden", "goldens", `${name}.json`),
          "utf8",
        ),
      ) as Golden
    const withFocus = entries[0]?.cases.find((c) => c.facts.focus === "keep the API stable")
    const local = entries[2]?.cases as Array<{ name?: string; fullText?: string }> | undefined
    const summaryFocus = local?.find((c) => c.name === "summary+focus")
    const body = withFocus?.text
    const fullText = summaryFocus?.fullText
    if (body === undefined || fullText === undefined) throw new Error("compact.json lacks a case")
    expect(body.length).toBeGreaterThan(0)
    expect(fullText).toContain("SUMMARY-BODY")
    // The checkpoint the golden expects: the fixture text with the golden summary.
    const checkpoint = fullText.replace("SUMMARY-BODY", "GOLDEN-SUMMARY-TEXT")

    const plain = loadGolden("local-compaction-summary-request")
    expect(plain.requests).toHaveLength(2)
    // No resolveSystemPrompt hook: the body is the only block.
    expect(plain.requests[0]?.system).toHaveLength(1)
    expect(plain.requests[0]?.system[0]?.text.length).toBe(body.length)
    expect(plain.requests[0]?.system.at(-1)?.text).toBe(body)

    // With the hook (15d0b): identity, ctx line, empty block dropped, body last.
    const pre = loadGolden("local-compaction-summary-request-preamble")
    expect(pre.requests).toHaveLength(2)
    expect(pre.requests[0]?.system.map((b) => b.text)).toEqual([
      "ID:GOLDEN-COMPACT-IDENTITY",
      "CTX:authKind=api-key modelId=golden-compact-model",
      body,
    ])

    // requests[1] of both: the checkpoint user message, then the kept tail.
    for (const g of [plain, pre]) {
      const msgs = g.requests[1]?.messages ?? []
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      expect(msgs[0]?.role).toBe("user")
      expect(msgs[0]?.content).toHaveLength(1)
      expect(msgs[0]?.content[0]?.type).toBe("text")
      expect(msgs[0]?.content[0]?.text).toBe(checkpoint)
      expect(msgs[1]?.role).toBe("user")
      expect(msgs[1]?.content[0]?.text).toBe("question two")
    }
  })
})
