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

import { lintText, type SteFinding } from "./ste-rules.ts"
import type { Surface } from "./surfaces.ts"

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
 * request. A snippet exemption covers only the quoted example, so new prose
 * around it is still audited. Each entry fails when the snippet is gone, so a
 * removed example removes its exemption.
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
 * Drop the findings that a reasoned exemption covers. A finding is exempt only
 * when its matched text sits inside an exact exempt snippet.
 *
 * @param file - Repo-relative file.
 * @param findings - Findings for that file.
 * @returns The findings that still apply.
 */
function applyExemptions(file: string, findings: readonly SteFinding[]): SteFinding[] {
  return findings.filter((finding) => {
    if (RULE_EXEMPTIONS.has(`${file}\u0000${finding.rule}`)) return false
    const snippets = EXEMPT_SNIPPETS.get(`${file}\u0000${finding.rule}`)
    if (!snippets) return true
    return !snippets.some((snippet) =>
      snippet.toLowerCase().includes(finding.snippet.toLowerCase()),
    )
  })
}

/**
 * Lint every surface and group the findings by file.
 *
 * @param surfaces - Surfaces from `allSurfaces` and `coreSurfaces`.
 * @returns One report for each file that has at least one finding.
 */
export function reportByFile(surfaces: readonly Surface[]): FileReport[] {
  const byFile = new Map<string, SteFinding[]>()
  for (const surface of surfaces) {
    const raw = lintText(surface.text, surface.line - 1, surface.file)
    // An empty prompt file is a defect the gate must see, unless the file is
    // empty on purpose. Each exception names the commit and the reason.
    if (surface.text.trim().length === 0 && !INTENTIONALLY_EMPTY.has(surface.file)) {
      raw.unshift({
        rule: "ste-s11-empty-surface",
        message: "the prompt file is empty: write the text or delete the file",
        snippet: surface.locator,
        line: 1,
        severity: "error",
      })
    }
    const findings = applyExemptions(surface.file, raw)
    if (findings.length === 0) continue
    const list = byFile.get(surface.file) ?? []
    list.push(...findings)
    byFile.set(surface.file, list)
  }
  return [...byFile.entries()]
    .map(([file, findings]) => ({ file, findings }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Turn file reports into baseline entries.
 *
 * @param reports - Reports from {@link reportByFile}.
 * @returns Sorted baseline entries.
 */
export function toEntries(reports: readonly FileReport[]): BaselineEntry[] {
  const counts = new Map<string, number>()
  for (const report of reports) {
    for (const finding of report.findings) {
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

/** One way that the current tree is worse than the baseline. */
export interface Regression {
  file: string
  rule: string
  baseline: number
  current: number
  reason: "above-baseline" | "new"
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
