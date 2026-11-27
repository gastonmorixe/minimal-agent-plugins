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

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import extraRules, { handlerMessageReports, isVerb } from "./extra-rules.ts"
import {
  BASELINE_PATH,
  EXEMPT_SNIPPETS,
  formatFinding,
  INTENTIONALLY_EMPTY,
  improvements,
  introduceEntries,
  isZeroTolerance,
  PROMOTE_AT_ZERO,
  promotionsDue,
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
const reports = reportByFile(surfaces, {
  extraFindings: extraRules,
  isVerb,
  extraReports: () => handlerMessageReports(),
})
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
    // Every plugin with a PROMPT.md must be in the corpus. The prompt diet
    // (2026-11-27) deleted most PROMPT.md files, so the check compares with
    // the files on disk, not with a count.
    const withPrompt = new Set(
      surfaces.filter((s) => s.kind === "prompt-md").map((s) => s.file.split("/")[0]),
    )
    const onDisk = readdirSync(PLUGINS_ROOT).filter(
      (dir) => dir.startsWith("ma-") && existsSync(resolve(PLUGINS_ROOT, dir, "PROMPT.md")),
    )
    expect(onDisk.length).toBeGreaterThan(0)
    expect([...withPrompt].sort()).toEqual(onDisk.sort())
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
    // In prose these rules are zero-tolerance too (promoted 2026-11-17), so
    // the same text is a regression there, never debt.
    const prose = reportByFile([planted(text)])
    expect(toEntries(prose)).toEqual([])
    expect([...new Set(zeroToleranceRegressions(prose).map((r) => r.rule))].sort()).toEqual([
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
    const ceiling = {
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
    expect(raisedEntries(next, ceiling).map((e) => e.rule)).toEqual([
      "ste-s15-slash",
      "ste-s13-paragraph",
    ])
    // --introduce opens exactly the named rule, when the rule is not known.
    expect(raisedEntries(next, ceiling, new Set(["ste-s15-slash"])).map((e) => e.rule)).toEqual([
      "ste-s13-paragraph",
    ])
    // A known rule never grows, also with --introduce.
    const known = new Set(["ste-s1-long-sentence", "ste-s15-slash"])
    const grown = [{ file: "a.md", rule: "ste-s1-long-sentence", count: 2 }]
    expect(raisedEntries(grown, ceiling, new Set(["ste-s1-long-sentence"]), known).length).toBe(1)
    expect(
      raisedEntries(next, ceiling, new Set(["ste-s15-slash"]), known).map((e) => e.rule),
    ).toEqual(["ste-s15-slash", "ste-s13-paragraph"])
    // introduceEntries writes the introduced rule and clamps every other raise.
    expect(introduceEntries(next, ceiling, new Set(["ste-s15-slash"]))).toEqual([
      { file: "a.md", rule: "ste-s1-long-sentence", count: 1 },
      { file: "a.md", rule: "ste-s15-slash", count: 2 },
    ])
    // A known rule is clamped too: nothing above the ceiling is written.
    expect(introduceEntries(next, ceiling, new Set(["ste-s15-slash"]), known)).toEqual([
      { file: "a.md", rule: "ste-s1-long-sentence", count: 1 },
    ])
  })

  test("REVIEW-C B2: an EMPTY ceiling plus --introduce of an existing rule still refuses a raise", () => {
    // origin/main had an empty baseline, so the old guard saw every rule as
    // new. The known set no longer comes from the ceiling entries.
    const empty = { version: 1 as const, generated: "x", entries: [] }
    const next = [{ file: "a.md", rule: "ste-s15-slash", count: 5 }]
    const known = new Set(["ste-s15-slash"])
    expect(raisedEntries(next, empty, new Set(["ste-s15-slash"]), known)).toEqual(next)
    expect(introduceEntries(next, empty, new Set(["ste-s15-slash"]), known)).toEqual([])
  })

  test("PROMOTE_AT_ZERO: a rule with no baseline entry is zero-tolerance", () => {
    // The promotion is a forced one-line move: when the last prose debt of a
    // rule is gone, this test fails until the rule moves to ZERO_TOLERANCE.
    expect(promotionsDue(readBaseline(BASELINE_PATH).entries)).toEqual([])
    for (const rule of [...PROMOTE_AT_ZERO, ...ZERO_TOLERANCE]) expect(RULE_IDS).toContain(rule)
    expect([...PROMOTE_AT_ZERO].filter((rule) => ZERO_TOLERANCE.has(rule))).toEqual([])
  })

  test("REVIEW-C B2: the ZERO_TOLERANCE set is pinned (a removal is a reviewed test diff)", () => {
    // A rule may move IN (from PROMOTE_AT_ZERO). A rule never moves out: the
    // ratchet lock pins the set too, and its history check fails on a removal.
    expect([...ZERO_TOLERANCE].sort()).toEqual([
      "ste-s1-long-sentence",
      "ste-s10-inconsistent-term",
      "ste-s11-empty-surface",
      "ste-s12-hidden-char",
      "ste-s13-paragraph",
      "ste-s14-abbreviation",
      "ste-s15-slash",
      "ste-s16-progressive",
      "ste-s17-modal",
      "ste-s18-fragment",
      "ste-s19-dictionary",
      "ste-s2-semicolon",
      "ste-s20-tool-name",
      "ste-s21-result-verb",
      "ste-s23-pos",
      "ste-s3-typographic",
      "ste-s4-banned-word",
      "ste-s5-phrasal-verb",
      "ste-s6-contraction",
      "ste-s7-passive",
      "ste-s8-shout-case",
      "ste-s9-sycophancy",
    ])
  })

  test("REVIEW-C m5: the PROMOTE_AT_ZERO set is pinned", () => {
    // Empty since 2026-11-17: every rule is zero-tolerance. A new prose rule
    // with debt goes here until its debt is gone.
    expect([...PROMOTE_AT_ZERO].sort()).toEqual([])
  })

  test("every rule id is in exactly one of ZERO_TOLERANCE and PROMOTE_AT_ZERO", () => {
    // A new rule must say how it is ratcheted, and an emptied set leaves a
    // rule in neither, so this fails.
    const unclassified = RULE_IDS.filter(
      (rule) => !ZERO_TOLERANCE.has(rule) && !PROMOTE_AT_ZERO.has(rule),
    )
    expect(unclassified).toEqual([])
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
