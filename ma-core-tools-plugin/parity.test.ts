/**
 * Byte parity with today's core text (core-prompts decouple P2.3).
 *
 * (a) `buildToolDefinitions([provider])` stringifies to the captured
 *     `tools.json` bytes.
 * (b) Every `synthetic.json` entry whose kind this plugin owns: the case runs
 *     through the real core helper (so the facts are exactly what core
 *     passes), with a strict resolver that calls this provider and never the
 *     core fallback. The text equals the fixture text.
 *
 * Core is imported by relative path in this test only.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
} from "../../minimal-agent-core/plugin-api/src/types/synthetic-text.ts"
import type { SyntheticTextResolver } from "../../minimal-agent-core/src/agent/synthetic-text.ts"
import {
  binaryRejectedText,
  imageSummaryText,
  imageTooLargeText,
  unsupportedEmbeddingText,
  unsupportedImageModalityText,
} from "../../minimal-agent-core/src/media/read-file.ts"
import { formatBytes as coreFormatBytes } from "../../minimal-agent-core/src/media/types.ts"
import {
  modeActiveStampText,
  modeChangeText,
  modeCliRefusalText,
  modeRefusalText,
} from "../../minimal-agent-core/src/modes/mode-text.ts"
import { ToolFeedbackTracker } from "../../minimal-agent-core/src/tools/feedback-tracker.ts"
import { buildToolDefinitions } from "../../minimal-agent-core/src/tools/tool-definitions.ts"
import * as T from "../../minimal-agent-core/src/tools/tool-result-text.ts"

import { createCoreToolsSyntheticProvider, formatBytes, KINDS } from "./synthetic-text.ts"
import { createCoreToolTextProvider } from "./tool-text.ts"

const FIXTURES = join(import.meta.dir, "..", "tests", "text-parity", "fixtures")

interface FixtureCase {
  args: unknown[]
  text: string
}
interface FixtureEntry {
  fn: string
  file: string
  proposedKind: string
  cases: FixtureCase[]
}

const entries = (
  JSON.parse(readFileSync(join(FIXTURES, "synthetic.json"), "utf8")) as {
    entries: FixtureEntry[]
  }
).entries

const OWN = new Set<string>(KINDS)
const kindOf = (e: FixtureEntry): string => e.proposedKind.split("{")[0] ?? ""
const rows = entries.filter((e) => OWN.has(kindOf(e)))

const provider = createCoreToolsSyntheticProvider()

/** A resolver that asks only this provider. The core fallback fails the test. */
function strict(calls: SyntheticKind[]): SyntheticTextResolver {
  return {
    resolve(kind: SyntheticKind, facts: SyntheticFacts): string {
      calls.push(kind)
      const text = provider.text(kind, facts)
      if (text === "") throw new Error(`empty text for ${kind}`)
      return text
    },
  }
}

/** The tuiPreviewHint fixture text for a tool and a raw path. */
function previewHint(tool: string, rawPath: string | undefined): string {
  const cases = entries.find((e) => e.fn === "tuiPreviewHint")?.cases ?? []
  const key = tool === "Bash" ? "Bash" : "Read"
  const hit = cases.find((c) => c.args[0] === key && (c.args[1] ?? "") === (rawPath ?? ""))
  if (!hit) throw new Error(`no tuiPreviewHint fixture for ${key} ${rawPath}`)
  return hit.text
}

/** The truncationHint fixture case whose text is `hint`. */
function truncationHintCase(hint: string): FixtureCase {
  const hit = entries.find((e) => e.fn === "truncationHint")?.cases.find((c) => c.text === hint)
  if (!hit) throw new Error(`no truncationHint fixture for ${hint}`)
  return hit
}

type Obj = Record<string, unknown>
const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number

/**
 * One fixture fn: how a case runs through the core helper, and (where the
 * old fn took a hint argument) how the fixture text maps to today's text.
 * Same mapping as core tool-result-text.parity.test.ts and
 * runtime-text.parity.test.ts.
 */
interface Row {
  run: (t: SyntheticTextResolver, args: unknown[]) => string
  expect?: (c: FixtureCase) => string
}

const ROWS: Record<string, Row> = {
  bashErrorResult: { run: (t, a) => T.bashErrorText(t, s(a[0])) },
  bashExitCodeResult: { run: (t, a) => T.bashExitCodeText(t, a[0] as number | null) },
  bashOutputCapMarker: { run: (t, a) => T.bashOutputCapText(t, n(a[0])) },
  bashTimedOutMarker: { run: (t, a) => T.bashTimedOutText(t, n(a[0])) },
  cdNoSuchDirectoryResult: { run: (t, a) => T.bashCdNoDirText(t, s(a[0])) },
  editErrorResult: { run: (t, a) => T.editErrorText(t, s(a[0])) },
  editOldStringMultipleMatchesResult: { run: (t, a) => T.editMultipleText(t, n(a[0]), s(a[1])) },
  editOldStringNotFoundResult: { run: (t, a) => T.editNotFoundText(t, s(a[0])) },
  fileEditedResult: { run: (t, a) => T.editEditedText(t, s(a[0]), n(a[1])) },
  fileWrittenResult: { run: (t, a) => T.writeWrittenText(t, s(a[0])) },
  globArgNotStringResult: { run: (t, a) => T.globArgNotStringText(t, s(a[0]), s(a[1])) },
  globErrorResult: { run: (t, a) => T.globErrorText(t, s(a[0])) },
  globMissingPatternResult: { run: (t) => T.globMissingPatternText(t) },
  globSkippedDirsNotice: { run: (t, a) => T.globSkippedDirsText(t, n(a[0])) },
  globTimeoutNotice: { run: (t, a) => T.globTimeoutText(t, n(a[0]), n(a[1])) },
  grepErrorResult: { run: (t, a) => T.grepErrorText(t, s(a[0])) },
  noFilesMatchedResult: { run: (t) => T.globNoFilesText(t) },
  noMatchesFoundResult: { run: (t) => T.grepNoMatchesText(t) },
  readErrorResult: { run: (t, a) => T.readErrorText(t, s(a[0])) },
  readTooLargeResult: { run: (t, a) => T.readTooLargeText(t, s(a[0]), n(a[1])) },
  whitespaceResolvedNote: { run: (t, a) => T.readWhitespaceText(t, s(a[0])) },
  writeArgNotStringResult: { run: (t, a) => T.writeArgNotStringText(t, s(a[0]), s(a[1])) },
  writeErrorResult: { run: (t, a) => T.writeErrorText(t, s(a[0])) },
  writeMissingContentResult: { run: (t) => T.writeMissingContentText(t) },
  writeMissingPathResult: { run: (t) => T.writeMissingPathText(t) },
  // P3.7 kinds (old text: core 56fc856 inline strings).
  writeTrackedFileNotReadResult: { run: (t, a) => T.notReadText(t, "Write", s(a[1])) },
  editTrackedFileNotReadResult: { run: (t, a) => T.notReadText(t, "Edit", s(a[1])) },
  writeTrackedFileStaleResult: {
    run: (t, a) => T.staleReadText(t, "Write", s(a[1]), a[2] as "missing" | "changed"),
  },
  editTrackedFileStaleResult: {
    run: (t, a) => T.staleReadText(t, "Edit", s(a[1]), a[2] as "missing" | "changed"),
  },
  bashAbortedMarker: { run: (t) => T.bashAbortedText(t) },
  grepTimedOutResult: { run: (t, a) => T.grepTimedOutText(t, n(a[0]), a[1] as "rg" | "js") },
  grepExitCodeResult: { run: (t, a) => T.grepExitCodeText(t, n(a[0])) },
  filesStatsNotEnabledResult: { run: (t) => T.filesStatsNotEnabledText(t) },
  filesStatsEmptyReport: { run: (t, a) => T.filesStatsEmptyText(t, a[0] === true) },
  binaryWithheldProse: { run: (t, a) => T.binaryWithheldText(t, a[0] === true, a[1] === true) },
  cliToolGateRefusal: {
    run: (t, a) => modeCliRefusalText(t, s(a[0]), a[1] as "deny-all" | "allow-list"),
  },
  outputPreviewAnnotation: {
    run: (t, a) => {
      const o = a[0] as Obj
      const rawPath = s(o.path ?? "")
      const tag = T.previewTagText(t, {
        shown: n(o.shown),
        total: n(o.total),
        tool: s(o.tool),
        ...(rawPath ? { rawPath } : {}),
      })
      return `${s(o.content)}\n\n${tag}`
    },
    // The old fn took the hint. Today the kind renders it from the tool.
    expect: (c) => {
      const o = c.args[0] as Obj
      const end = `>${s(o.hint)}</ma::agent::output-preview>`
      expect(c.text.endsWith(end)).toBe(true)
      const hint = previewHint(s(o.tool), s(o.path ?? "") || undefined)
      return `${c.text.slice(0, -end.length)}>${hint}</ma::agent::output-preview>`
    },
  },
  tuiPreviewHint: {
    run: (t, a) => {
      const rawPath = s(a[1] ?? "")
      const tag = T.previewTagText(t, {
        shown: 1,
        total: 2,
        tool: s(a[0]),
        ...(rawPath ? { rawPath } : {}),
      })
      return tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</ma::agent::output-preview>"))
    },
  },
  truncatedOutputNotice: {
    run: (t, a) => {
      const o = a[0] as Obj
      const hint = s(o.hint)
      const tool = hint === "" ? "" : s(truncationHintCase(hint).args[0] ?? "")
      // "unknown" totals check the template bytes only. Core always has numbers.
      const total = (v: unknown): number => (/^\d+$/.test(s(v)) ? Number(v) : v) as number
      const notice = T.truncatedNoticeText(t, {
        tool,
        shownBytes: n(o.shownBytes),
        totalBytes: total(o.totalBytes),
        shownLines: n(o.shownLines),
        totalLines: total(o.totalLines),
        cutLine: n(o.cutLine),
        maxToolOutputBytes: 65536,
      })
      return `${s(o.kept)}\n\n${notice}`
    },
    expect: (c) => {
      const o = c.args[0] as Obj
      if (s(o.hint) !== "") return c.text
      // An empty hint: today the default (no tool) hint is rendered.
      const fallback = entries.find((e) => e.fn === "truncationHint")?.cases.at(-1)?.text ?? "?"
      expect(c.text.endsWith(". ]")).toBe(true)
      return `${c.text.slice(0, -1)}${fallback}]`
    },
  },
  truncationHint: {
    run: (t, a) => {
      const notice = T.truncatedNoticeText(t, {
        tool: s(a[0] ?? ""),
        shownBytes: 1,
        totalBytes: 2,
        shownLines: 1,
        totalLines: 2,
        cutLine: n(a[1]),
        maxToolOutputBytes: n(a[2]),
      })
      const head = `line ${n(a[1])}. `
      return notice.slice(notice.indexOf(head) + head.length, -1)
    },
  },
  streakNote: {
    run: (t, a) => {
      const tracker = new ToolFeedbackTracker(n(a[1]))
      let note: string | null = null
      for (let i = 0; i < n(a[1]); i++) note = tracker.observe(s(a[0]), true, t)
      return note ?? ""
    },
  },
  binaryDocumentRejectedMessage: {
    run: (t, a) => binaryRejectedText(t, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedEmbeddingMessage: {
    run: (t, a) => unsupportedEmbeddingText(t, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedImageModalityMessage: {
    run: (t, a) =>
      unsupportedImageModalityText(
        t,
        a[0] as { modelId: string; mimeType: string; sizeBytes: number },
      ),
  },
  fittedImageTooLargeMessage: {
    run: (t, a) =>
      imageTooLargeText(t, a[0] as { sizeBytes: number; limitBytes: number; modelId: string }),
  },
  imageSummaryMessage: {
    run: (t, a) =>
      imageSummaryText(
        t,
        a[0] as {
          subtype: string
          sizeBytes: number
          dimensions: { width: number; height: number } | null
          fittedStrategy: string | null
        },
      ),
  },
  modeToolRefusalMessage: {
    run: (t, a) => {
      const o = a[0] as Obj
      return modeRefusalText(t, {
        toolName: s(o.toolName),
        modeId: s(o.label).toLowerCase(),
        label: s(o.label),
        ...(o.refusalHint !== undefined ? { refusalHint: s(o.refusalHint) } : {}),
      })
    },
  },
  activeModeStamp: { run: (t, a) => modeActiveStampText(t, s(a[0]), s(a[1])) },
  modeChangeAttachment: {
    run: (t, a) => modeChangeText(t, a[0] as { from: string; to: string; at: string }),
  },
}

describe("tool definitions parity", () => {
  it("buildToolDefinitions([provider]) equals the captured JSON bytes", () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "tools.json"), "utf8")) as {
      toolDefinitionsJson: string
    }
    const defs = buildToolDefinitions([createCoreToolTextProvider()])
    expect(JSON.stringify(defs, null, 2)).toBe(fixture.toolDefinitionsJson)
  })

  it("every built-in tool gets its text from the provider, not the core fallback", () => {
    const p = createCoreToolTextProvider()
    for (const name of p.tools) {
      const t = p.tool(name)
      expect(t?.description.length ?? 0, name).toBeGreaterThan(0)
      expect(t?.description).toBe(t?.description.trim())
    }
    expect(p.tool("Fetch")).toBeUndefined()
  })
})

describe("synthetic text parity table", () => {
  it("covers a fixture row for every fixture entry of an owned kind", () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) expect(ROWS[e.fn], e.fn).toBeDefined()
  })

  it("every owned kind is exercised by some fixture row", () => {
    const hit = new Set(rows.map(kindOf))
    expect([...KINDS].filter((k) => !hit.has(k))).toEqual([])
  })

  for (const e of rows) {
    it(`${e.fn} (${kindOf(e)}) gives the fixture text through this provider`, () => {
      const row = ROWS[e.fn] as Row
      for (const c of e.cases) {
        const calls: SyntheticKind[] = []
        const want = row.expect ? row.expect(c) : c.text
        expect(row.run(strict(calls), c.args)).toBe(want)
        expect(calls).toEqual([kindOf(e) as SyntheticKind])
      }
    })
  }
})

describe("formatBytes (N1)", () => {
  it("equals core formatBytes on every boundary", () => {
    const K = 1024
    const M = K * K
    const G = M * K
    const cases = [0, 1, 1023, K, K + 1, 1536, 10 * K, M - 1, M, M + 1, 1.5 * M, G - 1, G, 3 * G]
    for (const b of cases) expect(formatBytes(b), String(b)).toBe(coreFormatBytes(b))
  })
})

describe("provider errors", () => {
  it("throws on a kind it does not own", () => {
    expect(() => provider.text("tool_result.aborted", { site: "runtime" })).toThrow()
  })

  it("throws on a missing required fact", () => {
    expect(() => provider.text("tool_text.Bash.cd_no_dir", {})).toThrow()
  })
})
