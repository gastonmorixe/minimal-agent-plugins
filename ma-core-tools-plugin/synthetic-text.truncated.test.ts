/**
 * The Read truncation notice (`tool_output.truncated`), M3c step 4c.
 *
 * (a) Facts only: the provider gets the facts that core sends and the text
 *     has the right bytes. An old core sends no M3c facts: the text stays the
 *     old text byte for byte.
 * (b) The real Read tool (`executeTool` of core, imported by relative path as
 *     parity.test.ts does) with this provider as the text source.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { SyntheticFacts } from "../../minimal-agent-core/plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver } from "../../minimal-agent-core/src/agent/synthetic-text.ts"
import { createDiagnostics } from "../../minimal-agent-core/src/diagnostics/hub.ts"
import { executeTool } from "../../minimal-agent-core/src/tools/tools.ts"
import { renderTruncatedNotice } from "../../minimal-agent-core/src/tools/truncation-parts.ts"

import { createCoreToolsSyntheticProvider } from "./synthetic-text.ts"

const provider = createCoreToolsSyntheticProvider()
const text = createSyntheticTextResolver([provider], createDiagnostics({ emit: () => {} }))
const notice = (facts: SyntheticFacts): string => provider.text("tool_output.truncated", facts)

/** The 7 legacy facts, as an old core sends them. */
const legacy = {
  tool: "Read",
  shownBytes: 64000,
  totalBytes: 200000,
  shownLines: 70,
  totalLines: 300,
  cutLine: 70,
  maxToolOutputBytes: 64000,
}
const OLD_READ =
  "[truncated: shown 64000 of 200000 bytes, 70/300 lines, cut at byte 64000, line 70. to continue, call Read with offset=70. Set limit if necessary.]"

describe("tool_output.truncated, facts only", () => {
  it("old core (no M3c facts): the Read text is the old text", () => {
    expect(notice(legacy)).toBe(OLD_READ)
  })

  it("a normal byte cut at a line end keeps the old text (all M3c facts present)", () => {
    const facts = {
      ...legacy,
      totalLinesKnown: true,
      cutMidLine: false,
      longLines: 0,
      lineCharCap: 8192,
      lastLinePartial: false,
      nextOffset: 70,
    }
    expect(notice(facts)).toBe(OLD_READ)
  })

  it("other tools keep their text, whatever the M3c facts are", () => {
    for (const tool of ["Grep", "Bash", "Glob", "Fetch", "WebSearch", "Other"]) {
      const old = notice({ ...legacy, tool })
      const withFacts = notice({
        ...legacy,
        tool,
        totalLinesKnown: false,
        cutMidLine: true,
        longLines: 2,
        lineCharCap: 8192,
        lastLinePartial: true,
        nextOffset: 69,
      })
      expect(withFacts).toBe(old)
    }
  })

  it("case A: only the per-line clamp cut text", () => {
    const facts = {
      ...legacy,
      shownBytes: 30000,
      totalBytes: 90000,
      shownLines: 73,
      totalLines: 73,
      cutLine: 73,
      totalLinesKnown: true,
      cutMidLine: true,
      longLines: 4,
      lineCharCap: 8192,
      lastLinePartial: false,
      nextOffset: 73,
    }
    expect(notice(facts)).toBe(
      '[truncated: shown 30000 of 90000 bytes. All 73 lines are shown, but the harness cut 4 long lines at about 8192 characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]',
    )
  })

  it("case A: one long line uses the singular, and the cap is the fact", () => {
    const facts = {
      ...legacy,
      shownBytes: 100,
      totalBytes: 9000,
      shownLines: 3,
      totalLines: 3,
      cutLine: 3,
      totalLinesKnown: true,
      cutMidLine: true,
      longLines: 1,
      lineCharCap: 4096,
      lastLinePartial: false,
      nextOffset: 3,
    }
    expect(notice(facts)).toBe(
      '[truncated: shown 100 of 9000 bytes. All 3 lines are shown, but the harness cut 1 long line at about 4096 characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]',
    )
  })

  it("per-line clamp plus lines left to read: not case A (old text)", () => {
    const facts = {
      ...legacy,
      totalLinesKnown: true,
      cutMidLine: true,
      longLines: 2,
      lineCharCap: 8192,
      lastLinePartial: false,
      nextOffset: 70,
    }
    expect(notice(facts)).toBe(OLD_READ)
  })

  it("case B: the byte cut is inside a line", () => {
    const facts = {
      ...legacy,
      shownLines: 8,
      totalLines: 20,
      cutLine: 8,
      totalLinesKnown: true,
      cutMidLine: true,
      longLines: 0,
      lineCharCap: 8192,
      lastLinePartial: true,
      nextOffset: 7,
    }
    expect(notice(facts)).toBe(
      "[truncated: shown 64000 of 200000 bytes, 8/20 lines, cut at byte 64000, line 8. line 8 is partial. To continue, call Read with offset=7, which shows that line again from its start. Set limit if necessary.]",
    )
  })

  it("case B wins over per-line clamp when the last line is partial", () => {
    const facts = {
      ...legacy,
      totalLinesKnown: true,
      cutMidLine: true,
      longLines: 3,
      lineCharCap: 8192,
      lastLinePartial: true,
      nextOffset: 69,
    }
    expect(notice(facts)).toContain("line 70 is partial. To continue, call Read with offset=69,")
  })

  it("unknown total: no offset hint and no line count", () => {
    const facts = {
      ...legacy,
      totalLinesKnown: false,
      cutMidLine: true,
      longLines: 1,
      lineCharCap: 8192,
      lastLinePartial: true,
      nextOffset: 69,
    }
    const out = notice(facts)
    expect(out).toBe(
      "[truncated: shown 64000 of 200000 bytes. The harness cut the output; the total number of lines is not known. Use Grep with a specific pattern, or Bash with sed -n/cut -c, to see the part that you need.]",
    )
    expect(out).not.toContain("offset=")
    expect(out).not.toContain("70/300")
  })

  it("unknown total is checked before case A", () => {
    const out = notice({
      ...legacy,
      totalLinesKnown: false,
      cutMidLine: true,
      longLines: 2,
      lineCharCap: 8192,
      lastLinePartial: false,
      nextOffset: 300,
    })
    expect(out).toContain("the total number of lines is not known")
  })

  it("an unknown-total Read notice through core's renderTruncatedNotice", () => {
    const out = renderTruncatedNotice(text, {
      tool: "Read",
      shownBytes: 10,
      totalBytes: 20,
      shownLines: 1,
      totalLines: 1,
      cutLine: 1,
      totalLinesKnown: false,
    })
    expect(out).toContain("the total number of lines is not known")
  })
})

describe("tool_output.truncated, real Read tool", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-read-notice-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const read = (file: string, input: Record<string, unknown> = {}) =>
    executeTool("Read", { file_path: join(dir, file), ...input }, { text })

  it("case B: a byte cut inside line 8; offset=7 shows line 8 from its start", async () => {
    // 20 lines of 8000 chars. Each line is distinct at its start.
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}:`.padEnd(8000, "x"))
    writeFileSync(join(dir, "partial.txt"), lines.join("\n"))
    const first = await read("partial.txt")
    const content = first.content as string
    const m =
      /\[truncated: shown (\d+) of (\d+) bytes, (\d+)\/20 lines, cut at byte \1, line (\d+)\. (.*)\]$/.exec(
        content,
      )
    expect(m).not.toBeNull()
    expect(m?.[4]).toBe("8")
    expect(m?.[5]).toBe(
      "line 8 is partial. To continue, call Read with offset=7, which shows that line again from its start. Set limit if necessary.",
    )
    // The kept text ends inside line 8.
    const kept = content.slice(0, content.indexOf("\n\n[truncated:"))
    expect(kept.split("\n").length).toBe(8)
    expect(kept.endsWith("x")).toBe(true)

    const next = await read("partial.txt", { offset: 7 })
    const firstLine = (next.content as string).split("\n")[0] ?? ""
    expect(firstLine.startsWith("8\tL8:xxx")).toBe(true)
    // The full 8000-char line start: same first chars as the file line.
    expect(firstLine.slice(2, 2 + 100)).toBe(lines[7]?.slice(0, 100) ?? "?")
    expect(firstLine.length).toBe(`8\t${lines[7]}`.length)
  })

  it("case A: only the per-line clamp cuts; all lines are shown", async () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      i === 5 || i === 17 || i === 30 ? "W".repeat(20_000) : `short line ${i + 1}`,
    )
    const body = lines.join("\n")
    writeFileSync(join(dir, "longlines.txt"), body)
    const totalBytes = Buffer.byteLength(body, "utf8")
    const r = await read("longlines.txt")
    const content = r.content as string
    const shown = r._truncInfo?.shownBytes
    expect(shown).toBeDefined()
    expect(shown).toBeLessThan(64_000)
    expect(r._truncParts?.facts.totalBytes).toBeGreaterThan(0)
    expect(
      content.endsWith(
        `\n\n[truncated: shown ${shown} of ${totalBytes} bytes. All 40 lines are shown, but the harness cut 3 long lines at about 8192 characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]`,
      ),
    ).toBe(true)
    expect(content).not.toContain("offset=")
  })

  it("a normal byte cut at a line end keeps the old text", async () => {
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")
    writeFileSync(join(dir, "plain.txt"), `${body}\n`)
    const r = await read("plain.txt")
    expect(r._truncParts?.facts.lastLinePartial).toBe(false)
    expect(r._truncParts?.facts.longLines).toBe(0)
    expect(r.content as string).toMatch(
      /\[truncated: shown \d+ of \d+ bytes, 1000\/3001 lines, cut at byte \d+, line 1000\. to continue, call Read with offset=\d+\. Set limit if necessary\.\]$/,
    )
  })

  it("the real Read tool always knows the total lines (totalLinesKnown is true)", async () => {
    const r = await read("plain.txt")
    expect(r._truncParts?.facts.totalLinesKnown).toBe(true)
    // Not the unknown-total text.
    expect(r.content as string).not.toContain("the total number of lines is not known")
  })
})
