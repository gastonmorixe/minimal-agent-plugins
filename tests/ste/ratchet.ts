/**
 * Ratchet bookkeeping for the STE gate.
 *
 * The baseline is a JSON file with a count for each `file` + `rule` pair. The
 * gate passes when no pair goes above its baseline and no new pair appears.
 * A fix lowers the count, so the ratchet only moves one way. `--write`
 * records the current counts, and that is the only way a number can grow.
 *
 * @module tests/ste/ratchet
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import {
  type ExtraFindings,
  lintText,
  maskNonProse,
  type SteFinding,
  termPairFindings,
} from "./ste-rules.ts"
import { roleOf, type Surface } from "./surfaces.ts"

/** An entry in the baseline file. */
export interface BaselineEntry {
  /** Plugin-relative file, or `core/<path>` for a core file. */
  file: string
  /** Stable STE rule id. */
  rule: string
  /** Allowed number of findings for this pair. */
  count: number
}

/** The baseline file shape. */
export interface Baseline {
  version: 1
  generated: string
  entries: BaselineEntry[]
}

/** One file with its findings. */
export interface FileReport {
  file: string
  findings: SteFinding[]
}

/** The default baseline path. */
export const BASELINE_PATH = resolve(import.meta.dir, "ste-baseline.json")

/**
 * Prompt files that are empty on purpose. Each entry needs the commit and the
 * reason, so the exception is auditable. An exception that is no longer needed
 * is reported by the coverage test.
 */
export const INTENTIONALLY_EMPTY: ReadonlyMap<string, string> = new Map([
  [
    "ma-env-info-plugin/PROMPT.md",
    "39b5388 emptied it on purpose: the framing moved into the gather.sh fragment output, so an extra block here adds a second system section to every request",
  ],
])

/**
 * Files where a rule does not apply, keyed by `file` + `rule`. Each entry
 * needs a reason. A style guide that quotes a banned phrase on purpose is the
 * only reason so far: the quoted text is the subject of the file.
 */
export const RULE_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    "ma-agent-writing-style-plugin/PROMPT.md\u0000ste-s9-sycophancy",
    "the file lists the banned openers as examples on purpose",
  ],
])

/**
 * Exact quoted snippets that a rule must not judge, keyed by file and rule.
 *
 * A file-level exemption opens the whole file, and this file goes into every
 * request. A snippet exemption covers only the quoted example: a finding is
 * exempt only when its offset falls inside one copy of the snippet in the
 * surface text (bug B2). New prose around it is still audited. A test fails
 * when a snippet is gone from its file (bug B7), so a removed example removes
 * its exemption.
 */
export const EXEMPT_SNIPPETS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "ma-agent-writing-style-plugin/PROMPT.md\u0000ste-s6-contraction",
    ["Let me know if you'd like me to expand", "Let's dive in", "Here's what you need to know"],
  ],
  [
    "ma-agent-writing-style-plugin/PROMPT.md\u0000ste-s9-sycophancy",
    [
      "Great question!",
      "Absolutely!",
      "Certainly!",
      "I hope this helps!",
      "Let me know if you'd like me to expand",
      "Let's dive in",
      "Here's what you need to know",
      "Without further ado",
      "as an AI language model",
    ],
  ],
])

/**
 * Character ranges of every copy of each snippet in a text.
 *
 * @param text - The surface text.
 * @param snippets - The exempt snippets.
 * @returns `[start, end)` ranges.
 */
function snippetRanges(text: string, snippets: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const lower = text.toLowerCase()
  for (const snippet of snippets) {
    const needle = snippet.toLowerCase()
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      out.push([at, at + needle.length])
    }
  }
  return out
}

/**
 * Drop the findings that a reasoned exemption covers.
 *
 * @param file - Repo-relative file.
 * @param text - The surface text that gave the findings.
 * @param findings - Findings for that text, with offsets.
 * @returns The findings that still apply.
 */
export function applyExemptions(
  file: string,
  text: string,
  findings: readonly SteFinding[],
): SteFinding[] {
  return findings.filter((finding) => {
    if (RULE_EXEMPTIONS.has(`${file}\u0000${finding.rule}`)) return false
    const snippets = EXEMPT_SNIPPETS.get(`${file}\u0000${finding.rule}`)
    if (!snippets || finding.offset === undefined) return true
    const at = finding.offset
    return !snippetRanges(text, snippets).some(([start, end]) => at >= start && at < end)
  })
}

/** Options for {@link reportByFile}. */
export interface ReportOptions {
  /**
   * Rules from another module (s19 dictionary, s20 tool names). Called once
   * for each surface. `scripts/ste-check.ts` loads it from
   * `tests/ste/extra-rules.ts` when that file exists.
   */
  extraFindings?: ExtraFindings
  /**
   * Base-form verb test for the instruction classifier (R3 B11). The extra
   * rules module passes `Dictionary.isVerb`, so an STE verb that starts a
   * sentence makes it an instruction (limit 20), not a description (25).
   */
  isVerb?: (word: string) => boolean
}

/**
 * Lint every surface and group the findings by file.
 *
 * s10 (one word for one meaning) runs once per FILE on the text of every
 * surface of that file, because its message says "in this file" (bug B5).
 *
 * @param surfaces - Surfaces from `allSurfaces` and `coreSurfaces`.
 * @param opts - Optional extra rules.
 * @returns One report for each file that has at least one finding.
 */
export function reportByFile(surfaces: readonly Surface[], opts: ReportOptions = {}): FileReport[] {
  const byFile = new Map<string, SteFinding[]>()
  const maskedByFile = new Map<string, string[]>()
  for (const surface of surfaces) {
    const role = surface.role ?? roleOf(surface)
    const raw = lintText(surface.text, surface.line - 1, surface.file, {
      role,
      termPairs: false,
      extraFindings: opts.extraFindings,
      isVerb: opts.isVerb,
    })
    for (const finding of raw) finding.locator = surface.locator
    const masks = maskedByFile.get(surface.file) ?? []
    masks.push(maskNonProse(surface.text))
    maskedByFile.set(surface.file, masks)
    // An empty prompt file is a defect the gate must see, unless the file is
    // empty on purpose. Each exception names the commit and the reason.
    if (surface.text.trim().length === 0 && !INTENTIONALLY_EMPTY.has(surface.file)) {
      raw.unshift({
        rule: "ste-s11-empty-surface",
        message: "the prompt file is empty: write the text or delete the file",
        snippet: surface.locator,
        line: 1,
        severity: "error",
        role,
        locator: surface.locator,
      })
    }
    const findings = applyExemptions(surface.file, surface.text, raw)
    if (findings.length === 0) continue
    const list = byFile.get(surface.file) ?? []
    list.push(...findings)
    byFile.set(surface.file, list)
  }
  for (const [file, masks] of maskedByFile) {
    const pairs = termPairFindings(masks.join("\n\n"))
    if (pairs.length === 0) continue
    const list = byFile.get(file) ?? []
    for (const [rule, message, snippet] of pairs) {
      list.push({ rule, message, snippet, line: 1, severity: "warn", role: "prose" })
    }
    byFile.set(file, list)
  }
  return [...byFile.entries()]
    .map(([file, findings]) => ({ file, findings }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * True when a finding can never enter the baseline: every finding in the tool
 * block (role `tool` or `param`, DESIGN D2), and every finding of a rule in
 * {@link ZERO_TOLERANCE}.
 *
 * @param finding - One finding.
 * @returns True when the finding is always a regression.
 */
export function isZeroTolerance(finding: Pick<SteFinding, "rule" | "role">): boolean {
  return finding.role === "tool" || finding.role === "param" || ZERO_TOLERANCE.has(finding.rule)
}

/**
 * Rules that land clean in every role. A finding is a regression, never a
 * baseline entry (R3 A4). s14 and s17 are errors in prose too (DESIGN 2), and
 * s20 is zero-tolerance in every role.
 *
 * Note: s14 and s17 have prose debt today, recorded with `--introduce`.
 * TODO(ste): move them here when that debt is zero. The PROMOTE_AT_ZERO test
 * forces the move.
 */
export const ZERO_TOLERANCE: ReadonlySet<string> = new Set([
  // Clean on origin/main (the baseline was empty), so promoted at once.
  "ste-s1-long-sentence",
  "ste-s5-phrasal-verb",
  "ste-s8-shout-case",
  "ste-s10-inconsistent-term",
  "ste-s2-semicolon",
  "ste-s3-typographic",
  "ste-s4-banned-word",
  "ste-s6-contraction",
  "ste-s9-sycophancy",
  "ste-s11-empty-surface",
  "ste-s12-hidden-char",
  // s19 keeps its prose debt in tests/ste/dictionary/pending.json, which
  // removes a recorded word before it becomes a finding. So every s19 finding
  // is a NEW word, and a new word fails at once.
  "ste-s19-dictionary",
  "ste-s20-tool-name",
  "ste-s21-result-verb",
])

/**
 * Rules that carry recorded prose debt today and become zero-tolerance when
 * that debt is gone. A test fails when one of them has no baseline entry and
 * is not yet in {@link ZERO_TOLERANCE}, so the promotion is a forced one-line
 * move.
 */
export const PROMOTE_AT_ZERO: ReadonlySet<string> = new Set([
  "ste-s7-passive",
  "ste-s13-paragraph",
  "ste-s14-abbreviation",
  "ste-s15-slash",
  "ste-s16-progressive",
  "ste-s17-modal",
  "ste-s18-fragment",
])

/**
 * Turn file reports into baseline entries. A zero-tolerance finding is not
 * an entry: see {@link zeroToleranceFindings}.
 *
 * @param reports - Reports from {@link reportByFile}.
 * @returns Sorted baseline entries.
 */
export function toEntries(reports: readonly FileReport[]): BaselineEntry[] {
  const counts = new Map<string, number>()
  for (const report of reports) {
    for (const finding of report.findings) {
      if (isZeroTolerance(finding)) continue
      const key = `${report.file}\u0000${finding.rule}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, rule] = key.split("\u0000")
      return { file: file as string, rule: rule as string, count }
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))
}

/**
 * Read a baseline file.
 *
 * @param path - Path of the baseline. Defaults to the repo baseline.
 * @returns The parsed baseline.
 */
export function readBaseline(path: string = BASELINE_PATH): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline
}

/**
 * Write a baseline file.
 *
 * @param entries - Entries to record.
 * @param path - Path of the baseline.
 * @param now - Timestamp for the file header.
 */
export function writeBaseline(
  entries: readonly BaselineEntry[],
  path: string = BASELINE_PATH,
  now: Date = new Date(),
): void {
  const body: Baseline = {
    version: 1,
    generated: now.toISOString(),
    entries: [...entries],
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * Every zero-tolerance finding (tool block, or a rule in ZERO_TOLERANCE).
 * These are regressions at any count and never enter the baseline.
 *
 * @param reports - Reports from {@link reportByFile}.
 * @returns The file and finding of each one.
 */
export function zeroToleranceFindings(
  reports: readonly FileReport[],
): Array<{ file: string; finding: SteFinding }> {
  return reports.flatMap((report) =>
    report.findings
      .filter((finding) => isZeroTolerance(finding))
      .map((finding) => ({ file: report.file, finding })),
  )
}

/** One way that the current tree is worse than the baseline. */
export interface Regression {
  file: string
  rule: string
  baseline: number
  current: number
  reason: "above-baseline" | "new" | "zero-tolerance"
}

/**
 * Group zero-tolerance findings into regressions, one per file and rule.
 *
 * @param reports - Reports from {@link reportByFile}.
 * @returns One regression per file and rule, with `reason: "zero-tolerance"`.
 */
export function zeroToleranceRegressions(reports: readonly FileReport[]): Regression[] {
  const counts = new Map<string, number>()
  for (const { file, finding } of zeroToleranceFindings(reports)) {
    const key = `${file}\u0000${finding.rule}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, rule] = key.split("\u0000") as [string, string]
      return { file, rule, baseline: 0, current: count, reason: "zero-tolerance" as const }
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))
}

/**
 * The entries that a `ste:write` would raise without permission.
 *
 * The limit of a pair is its count at the merge base. A rule id that is not
 * at the merge base was introduced on this branch: its pairs may keep the
 * count in the working baseline (`current`), never more. `--introduce <rule>`
 * lets a rule that is new at the merge base record all of its prose debt.
 * Tool-role, param-role and zero-tolerance findings are never entries, so
 * `--introduce` cannot record them.
 *
 * @param next - Today's entries from {@link toEntries}.
 * @param base - The merge-base baseline (or undefined: no guard).
 * @param introduce - Rule ids that may enter the baseline in this write.
 * @param current - The working baseline (the file on disk), if any.
 * @returns The entries that go above their limit.
 */
export function raisedEntries(
  next: readonly BaselineEntry[],
  base: Baseline | undefined,
  introduce: ReadonlySet<string> = new Set(),
  current?: Baseline,
): BaselineEntry[] {
  if (!base) return []
  const known = new Set(base.entries.map((e) => e.rule))
  const limit = new Map(base.entries.map((e) => [`${e.file}\u0000${e.rule}`, e.count]))
  for (const e of current?.entries ?? []) {
    if (known.has(e.rule)) continue
    limit.set(`${e.file}\u0000${e.rule}`, e.count)
  }
  return next.filter((entry) => {
    if (introduce.has(entry.rule) && !known.has(entry.rule)) return false
    return entry.count > (limit.get(`${entry.file}\u0000${entry.rule}`) ?? 0)
  })
}

/**
 * Compare the current tree with the baseline.
 *
 * @param current - Current entries from {@link toEntries}.
 * @param baseline - The recorded baseline.
 * @returns Each regression, sorted by file and rule.
 */
export function regressions(current: readonly BaselineEntry[], baseline: Baseline): Regression[] {
  const allowed = new Map(baseline.entries.map((e) => [`${e.file}\u0000${e.rule}`, e.count]))
  const out: Regression[] = []
  for (const entry of current) {
    const key = `${entry.file}\u0000${entry.rule}`
    const limit = allowed.get(key)
    if (limit === undefined) {
      out.push({
        file: entry.file,
        rule: entry.rule,
        baseline: 0,
        current: entry.count,
        reason: "new",
      })
      continue
    }
    if (entry.count > limit) {
      out.push({
        file: entry.file,
        rule: entry.rule,
        baseline: limit,
        current: entry.count,
        reason: "above-baseline",
      })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))
}

/**
 * Baseline entries that no longer have a finding. The ratchet says to lower
 * them, so a stale allowance is reported and removed by `--write`.
 *
 * @param current - Current entries from {@link toEntries}.
 * @param baseline - The recorded baseline.
 * @returns Each entry that is now below its baseline or gone.
 */
export function improvements(
  current: readonly BaselineEntry[],
  baseline: Baseline,
): BaselineEntry[] {
  const now = new Map(current.map((e) => [`${e.file}\u0000${e.rule}`, e.count]))
  return baseline.entries.filter(
    (entry) => (now.get(`${entry.file}\u0000${entry.rule}`) ?? 0) < entry.count,
  )
}

/**
 * The entries that `ste:write --introduce <rule>` writes: today's entries,
 * with each pair of ANOTHER rule clamped to its limit (see
 * {@link raisedEntries}). A pair with no limit is not written, so it stays a
 * regression for the gate. One `--introduce` run so records the debt of one
 * rule only.
 *
 * @param next - Today's entries from {@link toEntries}.
 * @param base - The merge-base baseline.
 * @param introduce - Rule ids that may enter the baseline in this write.
 * @param current - The working baseline (the file on disk), if any.
 * @returns The entries to write.
 */
export function introduceEntries(
  next: readonly BaselineEntry[],
  base: Baseline | undefined,
  introduce: ReadonlySet<string>,
  current?: Baseline,
): BaselineEntry[] {
  const raised = new Set(
    raisedEntries(next, base, introduce, current).map((e) => `${e.file}\u0000${e.rule}`),
  )
  const limit = new Map<string, number>()
  for (const e of [...(base?.entries ?? []), ...(current?.entries ?? [])]) {
    const key = `${e.file}\u0000${e.rule}`
    limit.set(key, Math.max(limit.get(key) ?? 0, e.count))
  }
  const known = new Set((base?.entries ?? []).map((e) => e.rule))
  const out: BaselineEntry[] = []
  for (const entry of next) {
    const key = `${entry.file}\u0000${entry.rule}`
    if (!raised.has(key)) {
      out.push(entry)
      continue
    }
    const cap = known.has(entry.rule)
      ? (base?.entries.find((e) => `${e.file}\u0000${e.rule}` === key)?.count ?? 0)
      : (limit.get(key) ?? 0)
    if (cap > 0) out.push({ ...entry, count: cap })
  }
  return out
}

/**
 * True when the run must not go on without the merge-base guard: in CI
 * (`CI` set), unless `STE_SKIP_BASELINE_GUARD=1` (bug B10).
 */
export function guardRequired(env: Record<string, string | undefined> = process.env): boolean {
  if (env.STE_SKIP_BASELINE_GUARD === "1") return false
  return Boolean(env.CI) && env.CI !== "0" && env.CI !== "false"
}

/**
 * A short line for one finding, safe to print.
 *
 * @param file - File of the finding.
 * @param finding - The finding.
 * @returns `file:line rule: message (snippet)`.
 */
export function formatFinding(file: string, finding: SteFinding): string {
  return `${file}:${finding.line} ${finding.rule}: ${finding.message} (${finding.snippet})`
}

/**
 * A markdown report of the current debt, grouped by plugin.
 *
 * @param reports - Reports from {@link reportByFile}.
 * @returns Markdown text.
 */
export function toMarkdown(reports: readonly FileReport[]): string {
  const totals = new Map<string, number>()
  for (const report of reports) {
    for (const finding of report.findings) {
      totals.set(finding.rule, (totals.get(finding.rule) ?? 0) + 1)
    }
  }
  const lines = ["# STE debt report", ""]
  lines.push(`Files with findings: ${reports.length}`, "")
  lines.push("## Findings per rule", "", "| Rule | Count |", "| --- | ---: |")
  for (const [rule, count] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${rule} | ${count} |`)
  }
  lines.push("", "## Worst files", "", "| File | Findings | Errors |", "| --- | ---: | ---: |")
  const worst = [...reports]
    .map((r) => ({
      file: r.file,
      total: r.findings.length,
      errors: r.findings.filter((f) => f.severity === "error").length,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 40)
  for (const row of worst) lines.push(`| ${row.file} | ${row.total} | ${row.errors} |`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

/**
 * The folder that holds the baseline. Exported so a test can assert the file
 * is in the repo, not in a temp folder.
 */
export const BASELINE_DIR = dirname(BASELINE_PATH)
