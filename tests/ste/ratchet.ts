/**
 * Ratchet bookkeeping for the STE gate.
 *
 * The baseline is a JSON file with a count for each `file` + `rule` pair. The
 * gate passes when no pair goes above its baseline and no new pair appears.
 * A fix lowers the count, so the ratchet only moves one way. `--write`
 * records the current counts.
 *
 * The committed lock (`ratchet-lock.json`, {@link RatchetLock}) is the
 * ceiling of the baseline and of the s19 pending list. No write goes above
 * it, and a test fails when the lock itself goes up.
 *
 * @module tests/ste/ratchet
 */

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import {
  type ExtraFindings,
  lintText,
  maskNonProse,
  RULE_IDS,
  type SteFinding,
  termPairFindings,
} from "./ste-rules.ts"
import { PLUGINS_ROOT, roleOf, type Surface } from "./surfaces.ts"

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
  /**
   * Findings that come from outside the surfaces, for example the s20 check
   * of human text in plugin handler and lib code (REVIEW-C M1). They join the
   * report so the gate and the tests count them the same way.
   */
  extraReports?: () => readonly FileReport[]
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
  for (const report of opts.extraReports?.() ?? []) {
    if (report.findings.length === 0) continue
    const list = byFile.get(report.file) ?? []
    list.push(...report.findings)
    byFile.set(report.file, list)
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
 * A rule in {@link PROMOTE_AT_ZERO} moves here when its prose debt is zero.
 * The PROMOTE_AT_ZERO test forces the move.
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
  // Promoted 2026-11-17: the STE pass removed the last prose debt.
  "ste-s7-passive",
  "ste-s14-abbreviation",
  "ste-s17-modal",
  "ste-s19-dictionary",
  "ste-s20-tool-name",
  "ste-s21-result-verb",
  // s23 (part of speech, REVIEW-B MF8) lands clean: an error in every role.
  "ste-s23-pos",
  // Promoted 2026-11-17: the round-2 text fixes removed the last prose debt.
  "ste-s13-paragraph",
  "ste-s15-slash",
  "ste-s16-progressive",
  "ste-s18-fragment",
])

/**
 * Rules that carry recorded prose debt today and become zero-tolerance when
 * that debt is gone. A test fails when one of them has no baseline entry and
 * is not yet in {@link ZERO_TOLERANCE}, so the promotion is a forced one-line
 * move.
 */
export const PROMOTE_AT_ZERO: ReadonlySet<string> = new Set<string>([])

/**
 * The rules of `promote` that have no baseline entry and are not yet in
 * `zero`: each one must move to {@link ZERO_TOLERANCE} now.
 *
 * @param entries - The baseline entries.
 * @param promote - The rules that wait for zero debt.
 * @param zero - The zero-tolerance rules.
 * @returns The rules whose promotion is due, sorted.
 */
export function promotionsDue(
  entries: readonly BaselineEntry[],
  promote: ReadonlySet<string> = PROMOTE_AT_ZERO,
  zero: ReadonlySet<string> = ZERO_TOLERANCE,
): string[] {
  const withDebt = new Set(entries.map((entry) => entry.rule))
  return [...promote].filter((rule) => !withDebt.has(rule) && !zero.has(rule)).sort()
}

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
 * The limit of a pair is its count in the lock ceiling ({@link lockCeiling}),
 * never the merge base: the merge base may have no baseline at all, and then
 * every rule looked new (REVIEW-C B2). A pair of an introduced rule is not a
 * raise. `knownRules` must hold every rule that is already enforced, so
 * `--introduce` cannot reopen one (see {@link knownRules}).
 *
 * @param next - Today's entries from {@link toEntries}.
 * @param ceiling - The lock ceiling, as a baseline.
 * @param introduce - NEW rule ids that may record their prose debt in this write.
 * @param known - Rule ids that are already enforced. An introduce of one is ignored.
 * @returns The entries that go above their limit.
 */
export function raisedEntries(
  next: readonly BaselineEntry[],
  ceiling: Baseline,
  introduce: ReadonlySet<string> = new Set(),
  known: ReadonlySet<string> = new Set(),
): BaselineEntry[] {
  const limit = new Map(ceiling.entries.map((e) => [`${e.file}\u0000${e.rule}`, e.count]))
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
 * with each raised pair of ANOTHER rule clamped to its ceiling. A pair with no
 * ceiling is not written, so it stays a regression for the gate. One
 * `--introduce` run so records the debt of one NEW rule only.
 *
 * @param next - Today's entries from {@link toEntries}.
 * @param ceiling - The lock ceiling, as a baseline.
 * @param introduce - NEW rule ids that may record their prose debt.
 * @param known - Rule ids that are already enforced.
 * @returns The entries to write.
 */
export function introduceEntries(
  next: readonly BaselineEntry[],
  ceiling: Baseline,
  introduce: ReadonlySet<string>,
  known: ReadonlySet<string> = new Set(),
): BaselineEntry[] {
  const raised = new Set(
    raisedEntries(next, ceiling, introduce, known).map((e) => `${e.file}\u0000${e.rule}`),
  )
  const limit = new Map(ceiling.entries.map((e) => [`${e.file}\u0000${e.rule}`, e.count]))
  const out: BaselineEntry[] = []
  for (const entry of next) {
    const key = `${entry.file}\u0000${entry.rule}`
    if (!raised.has(key)) {
      out.push(entry)
      continue
    }
    const cap = limit.get(key) ?? 0
    if (cap > 0) out.push({ ...entry, count: cap })
  }
  return out
}

// ---------------------------------------------------------------------------
// The ratchet lock (REVIEW-C B1, B2)
// ---------------------------------------------------------------------------

/**
 * The committed ceiling of every ratcheted set. The merge base cannot be the
 * ceiling: origin/main has no pending.json and an empty baseline, so a guard
 * that reads it sees "first landing" and allows anything (REVIEW-C B1, B2).
 *
 * - `rules`: every rule id that exists and is enforced. `--introduce` refuses
 *   each one. A rule leaves this list only by a raise (a test fails).
 * - `zeroTolerance`: the {@link ZERO_TOLERANCE} set. A rule may join it,
 *   never leave it.
 * - `baseline`: `"<rule> @ <file>": count`, the prose debt of
 *   `ste-baseline.json`.
 * - `pending`: `"<word> @ <file>": count`, the s19 prose debt that
 *   `dictionary/pending.json` lets through, with the number of occurrences.
 *
 * The tree must not go above the lock, and the lock must not go above any
 * earlier copy of itself (HEAD, the merge base, every commit since the merge
 * base that changed it). Only `ste:write` and `ste:dict --write-pending`
 * write it, and both refuse a raise.
 */
export interface RatchetLock {
  version: 1
  rules: string[]
  zeroTolerance: string[]
  baseline: Record<string, number>
  pending: Record<string, number>
}

/** The lock path, relative to the plugins repo (for `git show`). */
export const LOCK_REL = "tests/ste/ratchet-lock.json"

/** The lock path on disk. */
export const LOCK_PATH = resolve(import.meta.dir, "ratchet-lock.json")

/** The key of one lock count: `<item> @ <file>`. An item (word, rule id) has no space. */
export function lockKey(item: string, file: string): string {
  return `${item} @ ${file}`
}

/** Split a lock key into the item and the file. */
export function splitLockKey(key: string): { item: string; file: string } {
  const at = key.indexOf(" @ ")
  return { item: key.slice(0, at), file: key.slice(at + 3) }
}

/** Code-unit order, so the file is the same on every machine. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A copy of a count map with sorted keys and no zero count. */
function sortedCounts(map: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(map).sort(byCodeUnit)) {
    const count = map[key] ?? 0
    if (count > 0) out[key] = count
  }
  return out
}

/** A lock in its canonical form: sorted, unique, no zero count. */
export function normalizeLock(lock: RatchetLock): RatchetLock {
  return {
    version: 1,
    rules: [...new Set(lock.rules)].sort(byCodeUnit),
    zeroTolerance: [...new Set(lock.zeroTolerance)].sort(byCodeUnit),
    baseline: sortedCounts(lock.baseline),
    pending: sortedCounts(lock.pending),
  }
}

/** Baseline entries as lock counts. */
export function entriesToCounts(entries: readonly BaselineEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of entries) out[lockKey(e.rule, e.file)] = e.count
  return out
}

/** The baseline part of a lock as a {@link Baseline}, for {@link regressions}. */
export function lockBaseline(lock: RatchetLock): Baseline {
  const entries = Object.entries(lock.baseline)
    .map(([key, count]) => {
      const { item, file } = splitLockKey(key)
      return { file, rule: item, count }
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))
  return { version: 1, generated: "lock", entries }
}

/**
 * Read the lock.
 *
 * @param path - The lock file.
 * @returns The lock. Throws when the file is missing: there is no first-landing path.
 */
export function readLock(path: string = LOCK_PATH): RatchetLock {
  return JSON.parse(readFileSync(path, "utf8")) as RatchetLock
}

/** The lock as file text (canonical, biome-stable). */
export function lockText(lock: RatchetLock): string {
  return `${JSON.stringify(normalizeLock(lock), null, 2)}\n`
}

/** Write the lock in its canonical form. */
export function writeLock(lock: RatchetLock, path: string = LOCK_PATH): void {
  writeFileSync(path, lockText(lock))
}

/**
 * Every count in `next` that is above `ceiling`: a key that is not in the
 * ceiling, or a higher count. Used for the pending pairs (REVIEW-C B1).
 *
 * @param next - `"<word> @ <file>": count` of the tree or of a new lock.
 * @param ceiling - The allowed counts.
 * @returns One `key: count > limit` line per raise.
 */
export function pendingAdditions(
  next: Readonly<Record<string, number>>,
  ceiling: Readonly<Record<string, number>>,
): string[] {
  const out: string[] = []
  for (const [key, count] of Object.entries(next)) {
    const limit = ceiling[key] ?? 0
    if (count > limit) out.push(`${key}: ${count} > ${limit}${limit === 0 ? " (new)" : ""}`)
  }
  return out.sort(byCodeUnit)
}

/**
 * Every way that `next` is above `prev`. A lock may only go down.
 *
 * - A rule id in `prev.rules` that is not in `next.rules` (it could then be
 *   introduced again), or in `prev.zeroTolerance` and not in `next.zeroTolerance`.
 * - A baseline count above `prev`, or a new baseline key. A key of a rule
 *   that `prev` does not know is allowed: that is a NEW rule, introduced once.
 * - A pending count above `prev`, or a new pending pair.
 *
 * @param next - The lock that is checked (the working copy).
 * @param prev - An earlier copy (HEAD, the merge base, an earlier commit).
 * @returns One line per raise. Empty means `next` is at or below `prev`.
 */
export function lockRaises(next: RatchetLock, prev: RatchetLock): string[] {
  const out: string[] = []
  const nextRules = new Set(next.rules)
  const prevRules = new Set(prev.rules)
  for (const rule of prev.rules) {
    if (!nextRules.has(rule)) out.push(`rules: ${rule} removed`)
  }
  const nextZero = new Set(next.zeroTolerance)
  for (const rule of prev.zeroTolerance) {
    if (!nextZero.has(rule)) out.push(`zeroTolerance: ${rule} removed`)
  }
  for (const [key, count] of Object.entries(next.baseline)) {
    if (!prevRules.has(splitLockKey(key).item)) continue
    const limit = prev.baseline[key] ?? 0
    if (count > limit) out.push(`baseline: ${key}: ${count} > ${limit}`)
  }
  for (const line of pendingAdditions(next.pending, prev.pending)) out.push(`pending: ${line}`)
  return out
}

/**
 * Lock entries that break the shape: a baseline key whose rule is not in
 * `rules` or is zero-tolerance, a key with no ` @ `, or a count that is not a
 * positive integer.
 */
export function lockProblems(lock: RatchetLock): string[] {
  const out: string[] = []
  const rules = new Set(lock.rules)
  const zero = new Set(lock.zeroTolerance)
  for (const rule of lock.zeroTolerance) {
    if (!rules.has(rule)) out.push(`zeroTolerance: ${rule} is not in rules`)
  }
  if (lock.version !== 1) out.push(`version ${String(lock.version)}`)
  for (const [part, map] of [
    ["baseline", lock.baseline],
    ["pending", lock.pending],
  ] as const) {
    for (const [key, count] of Object.entries(map)) {
      if (!key.includes(" @ ")) out.push(`${part}: bad key ${key}`)
      if (!Number.isInteger(count) || count <= 0) out.push(`${part}: bad count ${key}: ${count}`)
      if (part === "baseline" && !rules.has(splitLockKey(key).item)) {
        out.push(`baseline: ${key}: the rule is not in rules`)
      }
      if (part === "baseline" && zero.has(splitLockKey(key).item)) {
        out.push(`baseline: ${key}: the rule is zero-tolerance`)
      }
    }
  }
  return out
}

/**
 * The lowest of two locks: the union of the rule lists, and for each key the
 * lower count (a key that one side does not have is 0 there). A baseline key
 * of a rule that one side does not know takes the count of the other side.
 */
export function meetLocks(a: RatchetLock, b: RatchetLock): RatchetLock {
  const aRules = new Set(a.rules)
  const bRules = new Set(b.rules)
  const baseline: Record<string, number> = {}
  for (const key of new Set([...Object.keys(a.baseline), ...Object.keys(b.baseline)])) {
    const rule = splitLockKey(key).item
    const la = aRules.has(rule) ? (a.baseline[key] ?? 0) : Number.POSITIVE_INFINITY
    const lb = bRules.has(rule) ? (b.baseline[key] ?? 0) : Number.POSITIVE_INFINITY
    const min = Math.min(la, lb)
    if (Number.isFinite(min) && min > 0) baseline[key] = min
  }
  const pending: Record<string, number> = {}
  for (const [key, count] of Object.entries(a.pending)) {
    const min = Math.min(count, b.pending[key] ?? 0)
    if (min > 0) pending[key] = min
  }
  return normalizeLock({
    version: 1,
    rules: [...a.rules, ...b.rules],
    zeroTolerance: [...a.zeroTolerance, ...b.zeroTolerance],
    baseline,
    pending,
  })
}

/** Run git in the plugins repo. Undefined on any error. */
function git(args: readonly string[], cwd: string = PLUGINS_ROOT): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return undefined
  }
}

/** One committed copy of the lock. */
export interface LockVersion {
  ref: string
  lock: RatchetLock
}

/**
 * Every committed ref that holds a copy of `path` the working copy must not go
 * above:
 * - HEAD and the merge base with origin/main;
 * - each commit since the merge base that changed `path`;
 * - the upstream of this branch (`@{u}`, the pushed copy) and each commit
 *   since the merge base on it that changed `path`.
 *
 * The upstream closes the squash bypass (REVIEW-C2 K2/K3): before the first
 * landing, origin/main has no copy, so a local squash onto the merge base
 * would leave HEAD as the only copy and a raise in it would become the
 * ceiling. The pushed copies stay until a force push, and a force push of a
 * ratchet file is a visible review event.
 *
 * @param path - Repo-relative file.
 * @param cwd - The repo folder.
 * @returns Unique refs, HEAD first.
 */
export function historyRefs(path: string, cwd: string = PLUGINS_ROOT): string[] {
  const refs = ["HEAD"]
  const base = git(["merge-base", "HEAD", "origin/main"], cwd)?.trim()
  const upstream = git(["rev-parse", "--verify", "--quiet", "@{u}"], cwd)?.trim()
  if (upstream) refs.push(upstream)
  if (base) {
    refs.push(base)
    for (const tip of ["HEAD", ...(upstream ? [upstream] : [])]) {
      const since = git(["rev-list", `${base}..${tip}`, "--", path], cwd) ?? ""
      for (const sha of since.split("\n")) if (sha.trim()) refs.push(sha.trim())
    }
  }
  return [...new Set(refs)]
}

/**
 * Every committed copy of the lock that the working copy must not go above
 * ({@link historyRefs}). A ref that has no lock is skipped (the first
 * landing, or a shallow clone with no merge base). A committed raise on the
 * branch so stays visible after the next commit.
 *
 * @param cwd - The repo folder.
 * @returns The copies, HEAD first.
 */
export function lockHistory(cwd: string = PLUGINS_ROOT): LockVersion[] {
  const out: LockVersion[] = []
  for (const ref of historyRefs(LOCK_REL, cwd)) {
    const raw = git(["show", `${ref}:${LOCK_REL}`], cwd)
    if (raw === undefined) continue
    out.push({ ref, lock: JSON.parse(raw) as RatchetLock })
  }
  return out
}

/**
 * The text of `path` at a ref, or undefined when git cannot read it.
 *
 * @param ref - A commit-ish.
 * @param path - Repo-relative file.
 * @param cwd - The repo folder.
 * @returns The file text.
 */
export function showAt(ref: string, path: string, cwd: string = PLUGINS_ROOT): string | undefined {
  return git(["show", `${ref}:${path}`], cwd)
}

/**
 * The ceiling that a write may not go above: the meet of the working lock
 * and every committed copy ({@link lockHistory}).
 *
 * @param working - The lock on disk.
 * @param history - The committed copies.
 * @returns The lowest lock.
 */
export function lockCeiling(
  working: RatchetLock = readLock(),
  history: readonly LockVersion[] = lockHistory(),
): RatchetLock {
  return history.reduce((acc, version) => meetLocks(acc, version.lock), normalizeLock(working))
}

/** The rule ids in a `ste-rules.ts` source text (every quoted `ste-sN-...` id). */
export function ruleIdsInSource(source: string): Set<string> {
  return new Set([...source.matchAll(/["'](ste-s\d+-[a-z0-9-]+)["']/g)].map((m) => m[1] as string))
}

/** The rule ids of `ste-rules.ts` at HEAD, or an empty set when git cannot read it. */
export function headRuleIds(cwd: string = PLUGINS_ROOT): Set<string> {
  const raw = git(["show", "HEAD:tests/ste/ste-rules.ts"], cwd)
  return raw === undefined ? new Set() : ruleIdsInSource(raw)
}

/**
 * Rule ids that are already enforced, so `--introduce` must refuse them: each
 * rule in the lock, each rule with a lock baseline entry, each rule in
 * {@link ZERO_TOLERANCE} and each rule id in `ste-rules.ts` at HEAD.
 * `--introduce` is only for a rule id that did not exist before.
 *
 * @param lock - The lock ceiling.
 * @param head - Rule ids at HEAD ({@link headRuleIds}).
 * @returns The known rule ids.
 */
export function knownRules(lock: RatchetLock, head: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>([...lock.rules, ...lock.zeroTolerance, ...ZERO_TOLERANCE, ...head])
  for (const key of Object.keys(lock.baseline)) out.add(splitLockKey(key).item)
  return out
}

/**
 * Why `--introduce <rule>` is refused, or undefined when the rule is new.
 *
 * @param rule - The rule id.
 * @param known - {@link knownRules}.
 * @param ruleIds - Every rule id of the working tree.
 * @returns The reason, or undefined.
 */
export function introduceRefusal(
  rule: string,
  known: ReadonlySet<string>,
  ruleIds: readonly string[] = RULE_IDS,
  zero: ReadonlySet<string> = ZERO_TOLERANCE,
): string | undefined {
  if (!ruleIds.includes(rule)) return `unknown rule id ${rule}`
  if (zero.has(rule)) return `${rule} is zero-tolerance, so it has no prose debt to record`
  if (known.has(rule)) {
    return `${rule} already exists and is enforced. --introduce is only for a NEW rule id`
  }
  return undefined
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
