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

import extraRules, { isVerb } from "./extra-rules.ts"
import {
  BASELINE_PATH,
  EXEMPT_SNIPPETS,
  formatFinding,
  guardRequired,
  INTENTIONALLY_EMPTY,
  improvements,
  introduceEntries,
  isZeroTolerance,
  PROMOTE_AT_ZERO,
  raisedEntries,
  readBaseline,
  regressions,
  reportByFile,
  toEntries,
  ZERO_TOLERANCE,
  zeroToleranceFindings,
  zeroToleranceRegressions,
} from "./ratchet.ts"
import { RULE_IDS, type SteFinding } from "./ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT, type Surface } from "./surfaces.ts"

const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
// The same extra rules (s19 dictionary, s20 tool names) that `ste-check.ts`
// loads, so the test suite and the gate give the same answer.
const reports = reportByFile(surfaces, { extraFindings: extraRules, isVerb })
const current = toEntries(reports)

/** A one-surface prompt file, for a planted case. */
function planted(text: string, file = "planted.md", extra: Partial<Surface> = {}): Surface {
  return { file, locator: "(whole file)", text, line: 1, kind: "prompt-md", ...extra }
}

/** Every finding of a report list, flat. */
function flat(list: ReturnType<typeof reportByFile>): SteFinding[] {
  return list.flatMap((report) => report.findings)
}

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
    // A zero-tolerance finding (tool block) is never covered: its own test fails.
    const files = reports
      .filter((r) => r.findings.some((f) => !isZeroTolerance(f)))
      .map((r) => r.file)
    expect(files.filter((file) => !covered.has(file))).toEqual([])
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

  test("tool role has no STE finding", () => {
    // DESIGN D2: the tool block ships on every request, so every rule is an
    // error there and nothing enters a baseline. This test stays red until
    // the tool text rewrite (phase C) lands. That is expected.
    const lines = zeroToleranceFindings(reports)
      .filter(({ finding }) => finding.role === "tool" || finding.role === "param")
      .map(({ file, finding }) => `${formatFinding(file, finding)} [${finding.locator}]`)
    expect(lines).toEqual([])
  })

  test("no prose finding of a zero-tolerance rule", () => {
    const lines = zeroToleranceFindings(reports)
      .filter(({ finding }) => finding.role !== "tool" && finding.role !== "param")
      .map(({ file, finding }) => formatFinding(file, finding))
    expect(lines).toEqual([])
  })

  test("the baseline holds no tool-role, param-role or zero-tolerance entry", () => {
    const baseline = readBaseline(BASELINE_PATH)
    for (const entry of baseline.entries) {
      expect(ZERO_TOLERANCE.has(entry.rule), `${entry.file} ${entry.rule}`).toBe(false)
    }
    // A file whose only findings are tool-role findings has no entry.
    const proseKeys = new Set(
      reports.flatMap((r) =>
        r.findings.filter((f) => !isZeroTolerance(f)).map((f) => `${r.file}\u0000${f.rule}`),
      ),
    )
    for (const entry of baseline.entries) {
      expect(proseKeys.has(`${entry.file}\u0000${entry.rule}`), `${entry.file} ${entry.rule}`).toBe(
        true,
      )
    }
  })

  test("a tool-role or param-role finding never becomes a baseline entry", () => {
    const text = "Takes no input. Use a/b. The job is running."
    for (const role of ["tool", "param"] as const) {
      const list = reportByFile([planted(text, "m.json", { role, kind: "manifest" })])
      expect(flat(list).length).toBeGreaterThan(0)
      expect(toEntries(list)).toEqual([])
      const zero = zeroToleranceRegressions(list)
      expect(zero.length).toBeGreaterThan(0)
      expect(zero.every((r) => r.reason === "zero-tolerance" && r.baseline === 0)).toBe(true)
    }
    // The same text in prose is recorded debt.
    const prose = toEntries(reportByFile([planted(text)]))
    expect(prose.map((e) => e.rule).sort()).toEqual([
      "ste-s15-slash",
      "ste-s16-progressive",
      "ste-s18-fragment",
    ])
  })

  test("a zero-tolerance rule never becomes a baseline entry in prose", () => {
    const list = reportByFile([planted("Utilize it; it's robust.")])
    expect(flat(list).length).toBeGreaterThan(0)
    expect(toEntries(list)).toEqual([])
  })

  test("--introduce lets only a new rule record its prose debt", () => {
    const base = {
      version: 1 as const,
      generated: "x",
      entries: [{ file: "a.md", rule: "ste-s1-long-sentence", count: 1 }],
    }
    const next = [
      { file: "a.md", rule: "ste-s1-long-sentence", count: 1 },
      { file: "a.md", rule: "ste-s15-slash", count: 2 },
      { file: "b.md", rule: "ste-s13-paragraph", count: 1 },
    ]
    // Without --introduce, every new pair is a raise.
    expect(raisedEntries(next, base).map((e) => e.rule)).toEqual([
      "ste-s15-slash",
      "ste-s13-paragraph",
    ])
    // --introduce opens exactly the named rule.
    expect(raisedEntries(next, base, new Set(["ste-s15-slash"])).map((e) => e.rule)).toEqual([
      "ste-s13-paragraph",
    ])
    // A rule that already has entries at the merge base never grows.
    const grown = [{ file: "a.md", rule: "ste-s1-long-sentence", count: 2 }]
    expect(raisedEntries(grown, base, new Set(["ste-s1-long-sentence"])).length).toBe(1)
    // A rule introduced on this branch keeps its working count, never more.
    const working = {
      ...base,
      entries: [...base.entries, { file: "a.md", rule: "ste-s15-slash", count: 2 }],
    }
    expect(raisedEntries(next, base, new Set(), working).map((e) => e.rule)).toEqual([
      "ste-s13-paragraph",
    ])
    const more = [{ file: "a.md", rule: "ste-s15-slash", count: 3 }]
    expect(raisedEntries(more, base, new Set(), working).length).toBe(1)
    // introduceEntries writes the introduced rule and clamps every other raise.
    expect(introduceEntries(next, base, new Set(["ste-s15-slash"]))).toEqual([
      { file: "a.md", rule: "ste-s1-long-sentence", count: 1 },
      { file: "a.md", rule: "ste-s15-slash", count: 2 },
    ])
    // No merge base: no guard (the CI check is separate).
    expect(raisedEntries(next, undefined)).toEqual([])
  })

  test("B10: CI without a merge-base baseline fails unless STE_SKIP_BASELINE_GUARD=1", () => {
    expect(guardRequired({ CI: "1" })).toBe(true)
    expect(guardRequired({ CI: "true" })).toBe(true)
    expect(guardRequired({ CI: "1", STE_SKIP_BASELINE_GUARD: "1" })).toBe(false)
    expect(guardRequired({})).toBe(false)
    expect(guardRequired({ CI: "false" })).toBe(false)
  })

  test("PROMOTE_AT_ZERO: a rule with no baseline entry is zero-tolerance", () => {
    // The promotion is a forced one-line move: when the last prose debt of a
    // rule is gone, this test fails until the rule moves to ZERO_TOLERANCE.
    const baseline = readBaseline(BASELINE_PATH)
    const withDebt = new Set(baseline.entries.map((entry) => entry.rule))
    const missing = [...PROMOTE_AT_ZERO].filter(
      (rule) => !withDebt.has(rule) && !ZERO_TOLERANCE.has(rule),
    )
    expect(missing).toEqual([])
    for (const rule of [...PROMOTE_AT_ZERO, ...ZERO_TOLERANCE]) expect(RULE_IDS).toContain(rule)
    expect([...PROMOTE_AT_ZERO].filter((rule) => ZERO_TOLERANCE.has(rule))).toEqual([])
  })

  test("B7: every EXEMPT_SNIPPETS entry still occurs in its file", () => {
    for (const [key, snippets] of EXEMPT_SNIPPETS) {
      const [file] = key.split("\u0000")
      const text = surfaces
        .filter((s) => s.file === file)
        .map((s) => s.text.toLowerCase())
        .join("\n")
      for (const snippet of snippets) {
        expect(text.includes(snippet.toLowerCase()), `stale exemption: ${file}: ${snippet}`).toBe(
          true,
        )
      }
    }
  })

  test("B2: an exemption covers only the quoted example, not the same word elsewhere", () => {
    const file = "ma-agent-writing-style-plugin/PROMPT.md"
    const text =
      "Cut these openers: `Let's dive in`, `Here's what you need to know`.\nLet's start now. It's fine."
    const found = flat(reportByFile([planted(text, file)])).filter(
      (f) => f.rule === "ste-s6-contraction",
    )
    expect(found.map((f) => f.snippet)).toEqual(["Let's", "It's"])
    expect(found.every((f) => f.line === 2)).toBe(true)
  })

  test("B5: s10 judges the whole file, not one surface", () => {
    const a = planted("Start the run.", "m.json", { locator: "a", kind: "manifest" })
    const b = planted("Begin the run.", "m.json", { locator: "b", kind: "manifest" })
    const found = flat(reportByFile([a, b])).filter((f) => f.rule === "ste-s10-inconsistent-term")
    expect(found.length).toBe(1)
    const other = planted("Begin the run.", "n.json", { locator: "b", kind: "manifest" })
    expect(flat(reportByFile([a, other])).some((f) => f.rule === "ste-s10-inconsistent-term")).toBe(
      false,
    )
  })

  test("reportByFile passes the extra rules once per surface", () => {
    let calls = 0
    const list = reportByFile([planted("Read it."), planted("Stop it.", "other.md")], {
      extraFindings: ({ file, role }) => {
        calls++
        return [
          {
            rule: "ste-s20-tool-name",
            message: "m",
            snippet: file,
            line: 1,
            severity: "error",
            role,
          },
        ]
      },
    })
    expect(calls).toBe(2)
    expect(flat(list).filter((f) => f.rule === "ste-s20-tool-name").length).toBe(2)
    // s20 is zero-tolerance in every role.
    expect(toEntries(list)).toEqual([])
  })

  test("the git-tracked baseline is valid JSON with a date", () => {
    const raw = readFileSync(BASELINE_PATH, "utf8")
    const parsed = JSON.parse(raw) as { generated?: string }
    expect(Number.isNaN(Date.parse(parsed.generated ?? ""))).toBe(false)
  })
})
