/**
 * STE corpus gate: the feedback loop over every model-facing text surface.
 *
 * The suite does three things:
 *
 * 1. Proves it found the corpus. A silken pass on 0 files is a bug, so the
 *    counts are asserted against a floor.
 * 2. Blocks a regression. The debt that exists today is recorded in
 *    `ste-baseline.json`, and any file or rule above its recorded count fails.
 *    A fix lowers a count, and `bun run ste:write` records the lower number.
 * 3. Shows the finish line. `ste:report` writes `ste-report.md` with the debt
 *    that is still open, so the work to reach zero is visible.
 *
 * @module tests/ste/ste-corpus.test
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  BASELINE_PATH,
  formatFinding,
  INTENTIONALLY_EMPTY,
  improvements,
  readBaseline,
  regressions,
  reportByFile,
  toEntries,
} from "./ratchet.ts"
import { RULE_IDS } from "./ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "./surfaces.ts"

const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
const reports = reportByFile(surfaces)
const current = toEntries(reports)

describe("STE corpus", () => {
  test("finds the surfaces it must audit", () => {
    expect(surfaces.length).toBeGreaterThan(350)
    const kinds = new Set(surfaces.map((surface) => surface.kind))
    for (const kind of ["prompt-md", "prompts-md", "manifest", "inline-ts"] as const) {
      expect(kinds.has(kind)).toBe(true)
    }
    // Every plugin with a PROMPT.md must be in the corpus.
    const withPrompt = new Set(
      surfaces.filter((s) => s.kind === "prompt-md").map((s) => s.file.split("/")[0]),
    )
    expect(withPrompt.size).toBeGreaterThanOrEqual(20)
  })

  test("audits the 3 text plugins that own the core prompt text", () => {
    for (const plugin of [
      "ma-base-prompt-plugin",
      "ma-core-tools-plugin",
      "ma-turn-recovery-plugin",
    ]) {
      expect(surfaces.some((s) => s.file.startsWith(`${plugin}/`))).toBe(true)
    }
  })

  test("audits the core model-facing text when the sibling checkout is present", () => {
    if (!existsSync(CORE_ROOT)) return
    expect(coreSurfaces(CORE_ROOT).length).toBeGreaterThan(0)
  })

  test("an empty prompt file is reported, unless it is empty on purpose", () => {
    // Every empty surface must be either a finding or a recorded exception.
    // The exception map needs the commit and the reason, so a silent skip is
    // impossible.
    const empty = surfaces.filter((s) => s.text.trim().length === 0)
    const reported = new Set(
      reports
        .filter((r) => r.findings.some((f) => f.rule === "ste-s11-empty-surface"))
        .map((r) => r.file),
    )
    const unexplained = empty.filter(
      (s) => !reported.has(s.file) && !INTENTIONALLY_EMPTY.has(s.file),
    )
    expect(unexplained.map((s) => s.file)).toEqual([])
    for (const file of reported) {
      expect(file in {}).toBe(false) // a reported file is never excused
      expect(INTENTIONALLY_EMPTY.has(file)).toBe(false)
    }
  })

  test("the intentionally-empty list is not stale", () => {
    // An exception for a file that has text again hides a real future gap.
    for (const [file, reason] of INTENTIONALLY_EMPTY) {
      const surface = surfaces.find((s) => s.file === file)
      expect(surface, `exception for a missing file: ${file}`).toBeDefined()
      expect(surface?.text.trim().length, `exception no longer needed: ${file}`).toBe(0)
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  test("no file or rule goes above its baseline count", () => {
    const baseline = readBaseline(BASELINE_PATH)
    const worse = regressions(current, baseline)
    const lines = worse.map(
      (w) => `${w.file} ${w.rule}: ${w.current} > ${w.baseline} (${w.reason})`,
    )
    expect(lines).toEqual([])
  })

  test("the baseline has no stale allowance for the gate to hide behind", () => {
    // An entry below its count means the text got better. That is expected
    // while the STE fix work is open; run `bun run ste:write` to record it.
    const baseline = readBaseline(BASELINE_PATH)
    const better = improvements(current, baseline)
    if (better.length > 0) {
      const hint = better.map((b) => `${b.file} ${b.rule} -> ${b.count}`).join("\n")
      throw new Error(`Baseline is above today's counts. Run: bun run ste:write\n${hint}`)
    }
  })

  test("the baseline file is versioned and lives in the repo", () => {
    expect(BASELINE_PATH).toBe(resolve(PLUGINS_ROOT, "tests/ste/ste-baseline.json"))
    const baseline = readBaseline(BASELINE_PATH)
    expect(baseline.version).toBe(1)
    // An empty list is the goal: it means the tree is clean. A non-empty list
    // must be a real allowance, never a negative count.
    for (const entry of baseline.entries) expect(entry.count).toBeGreaterThan(0)
  })

  test("a clean file has no finding and needs no baseline entry", () => {
    const files = new Set(reports.map((report) => report.file))
    expect(files.has("ma-base-prompt-plugin/prompts/identity.neutral.md")).toBe(false)
  })

  test("every finding points at a real line and a known rule", () => {
    for (const entry of current) {
      expect(entry.rule.startsWith("ste-")).toBe(true)
      expect(Number.isInteger(entry.count)).toBe(true)
      expect(entry.count).toBeGreaterThan(0)
    }
    // The rule ids that remain in the debt are a subset of the rule table.
    const known = new Set(RULE_IDS)
    for (const entry of current) expect(known.has(entry.rule)).toBe(true)
  })

  test("the report renders every finding without throwing", () => {
    const text = reports
      .flatMap((report) => report.findings.map((f) => formatFinding(report.file, f)))
      .join("\n")
    expect(text.split("\n").length).toBeGreaterThanOrEqual(current.reduce((n, e) => n + e.count, 0))
  })

  test("the gate catches a planted regression", () => {
    // A fake surface file with a banned word must produce a finding, so a
    // broken rule table cannot pass the corpus in silence.
    const planted = resolve(PLUGINS_ROOT, "tests/ste/__no_such_file__.md")
    expect(existsSync(planted)).toBe(false)
    const findings = reportByFile([
      {
        file: "planted.md",
        locator: "x",
        text: "Utilize it; it's robust.",
        line: 1,
        kind: "prompt-md",
      },
    ])
    expect(findings[0]?.findings.some((f) => f.rule === "ste-s4-banned-word")).toBe(true)
    expect(findings[0]?.findings.some((f) => f.rule === "ste-s2-semicolon")).toBe(true)
  })

  test("the baseline covers every file that has a finding today", () => {
    const baseline = readBaseline(BASELINE_PATH)
    const covered = new Set(baseline.entries.map((entry) => entry.file))
    expect([...reports.map((r) => r.file)].filter((file) => !covered.has(file))).toEqual([])
  })

  test("a baseline refresh does not hide a new file", () => {
    // Guard: the ratchet marks a pair with no baseline entry as `new`. A file
    // added after the last refresh must appear here, not pass in silence.
    const baseline = readBaseline(BASELINE_PATH)
    const known = new Set(baseline.entries.map((entry) => `${entry.file}\u0000${entry.rule}`))
    const fresh = current.filter((entry) => !known.has(`${entry.file}\u0000${entry.rule}`))
    expect(fresh).toEqual([])
  })

  test("the audit does not read its own report or baseline", () => {
    const self = surfaces.filter((s) => s.file.includes("tests/ste/"))
    expect(self).toEqual([])
  })

  test("the git-tracked baseline is valid JSON with a date", () => {
    const raw = readFileSync(BASELINE_PATH, "utf8")
    const parsed = JSON.parse(raw) as { generated?: string }
    expect(Number.isNaN(Date.parse(parsed.generated ?? ""))).toBe(false)
  })
})
