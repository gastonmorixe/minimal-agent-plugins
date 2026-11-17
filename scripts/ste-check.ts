#!/usr/bin/env bun
/**
 * STE gate: fail when model-facing prompt text gets worse than the baseline.
 *
 * The gate reads every surface (plugin `PROMPT.md`, `prompts/**.md`, manifest
 * `description` values, inline `systemPrompt:` / `description:` literals and a
 * small set of core files), runs the STE rules, and compares the counts with
 * `tests/ste/ste-baseline.json`.
 *
 * Usage:
 *   bun run scripts/ste-check.ts              # gate, exit 1 on a regression
 *   bun run scripts/ste-check.ts --report     # write tests/ste/ste-report.md
 *   bun run scripts/ste-check.ts --write      # record today's counts (never a raise)
 *   bun run scripts/ste-check.ts --write --introduce <rule-id>
 *                                             # let a NEW rule record its prose debt
 *   bun run scripts/ste-check.ts --strict     # fail on any finding, no baseline
 *   bun run scripts/ste-check.ts --dir <p>    # gate one other tree, no baseline
 *
 * A finding in the tool block (role `tool` or `param`) and a finding of a
 * zero-tolerance rule never enter the baseline. The gate fails on each one.
 *
 * Extra rules (s19 dictionary, s20 tool names) live in
 * `tests/ste/extra-rules.ts`. The gate loads that module only when it exists.
 * Its default export has the `ExtraFindings` signature of `ste-rules.ts`.
 *
 * @module scripts/ste-check
 */

import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  BASELINE_PATH,
  type Baseline,
  formatFinding,
  guardRequired,
  improvements,
  introduceEntries,
  type ReportOptions,
  raisedEntries,
  readBaseline,
  regressions,
  reportByFile,
  toEntries,
  toMarkdown,
  writeBaseline,
  zeroToleranceFindings,
  zeroToleranceRegressions,
} from "../tests/ste/ratchet.ts"
import { type ExtraFindings, RULE_IDS } from "../tests/ste/ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "../tests/ste/surfaces.ts"

interface Options {
  write: boolean
  report: boolean
  strict: boolean
  /** A folder to gate on its own. Its findings are printed, never baselined. */
  dir?: string
  /** With `--write`: new rule ids that may record their prose debt. */
  introduce: Set<string>
}

/** The optional extra-rules module, next to the engine. */
const EXTRA_RULES = resolve(import.meta.dir, "../tests/ste/extra-rules.ts")

/**
 * Load the extra rules (s19, s20) when `tests/ste/extra-rules.ts` exists.
 *
 * @returns The report options with the hook, or no hook.
 */
async function loadExtraRules(): Promise<ReportOptions> {
  if (!existsSync(EXTRA_RULES)) return {}
  try {
    const mod = (await import(EXTRA_RULES)) as { default?: unknown; isVerb?: unknown }
    if (typeof mod.default !== "function") {
      // The file exists, so its rules are expected. Turning them off with a
      // warning would pass s19/s20 debt in silence.
      console.error(`STE: ${EXTRA_RULES} has no default export function.`)
      process.exit(2)
    }
    const isVerb =
      typeof mod.isVerb === "function" ? (mod.isVerb as (word: string) => boolean) : undefined
    return { extraFindings: mod.default as ExtraFindings, isVerb }
  } catch (error) {
    // A broken extra-rules module must not pass in silence: it is a gate input.
    console.error(
      `STE: cannot load ${EXTRA_RULES}: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(2)
  }
}

const REPORT_OPTIONS: ReportOptions = await loadExtraRules()

/** Parse the command line. */
function parseArgs(argv: readonly string[]): Options {
  const options: Options = { write: false, report: false, strict: false, introduce: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--write") options.write = true
    else if (arg === "--report") options.report = true
    else if (arg === "--strict") options.strict = true
    else if (arg === "--introduce" && argv[i + 1]) {
      options.introduce.add(argv[i + 1] as string)
      i++
    } else if (arg === "--dir" && argv[i + 1]) {
      options.dir = resolve(argv[i + 1] as string)
      i++
    }
  }
  return options
}

/** Print a report of all findings and the totals. */
function printReport(options: Options): number {
  const surfaces = options.dir
    ? allSurfaces(options.dir)
    : [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const reports = reportByFile(surfaces, REPORT_OPTIONS)
  const entries = toEntries(reports)
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)

  console.log(`STE surfaces: ${surfaces.length}`)
  console.log(`Files with findings: ${reports.length}`)
  console.log(`Findings: ${total}`)

  const perRule = new Map<string, number>()
  for (const entry of entries) perRule.set(entry.rule, (perRule.get(entry.rule) ?? 0) + entry.count)
  for (const [rule, count] of [...perRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${rule}`)
  }

  if (options.dir || options.strict) {
    for (const report of reports) {
      for (const finding of report.findings) console.log(formatFinding(report.file, finding))
    }
  }
  return total
}

/** The merge-base baseline, if the repo has one. */
function mergeBaseBaseline(): Baseline | undefined {
  const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: PLUGINS_ROOT,
    encoding: "utf8",
  }).trim()
  if (!base) return undefined
  const raw = execFileSync("git", ["show", `${base}:tests/ste/ste-baseline.json`], {
    cwd: PLUGINS_ROOT,
    encoding: "utf8",
  })
  return JSON.parse(raw) as Baseline
}

/** Record today's counts, but never above the merge base. */
function writeMode(options: Options): number {
  if (options.dir) {
    console.error("--write needs the repo tree. Do not give --dir.")
    return 2
  }
  for (const rule of options.introduce) {
    if (!RULE_IDS.includes(rule)) {
      console.error(`--introduce: unknown rule id ${rule}`)
      return 2
    }
  }
  const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const reports = reportByFile(surfaces, REPORT_OPTIONS)
  // Tool-role, param-role and zero-tolerance findings are never written.
  let next = toEntries(reports)

  // A raise is a merge failure, not a review miss. Without this, a bad edit
  // plus `ste:write` makes the gate green.
  let base: Baseline | undefined
  try {
    base = mergeBaseBaseline()
  } catch {
    // Two honest cases: a shallow or detached CI clone, or the first commit
    // that adds the baseline. Say which, so the guard is never silently off.
    if (guardRequired()) {
      console.error(
        "STE: no baseline at the merge base, and CI is set. The raise guard cannot run.",
      )
      console.error(
        "  Fetch origin/main, or set STE_SKIP_BASELINE_GUARD=1 on the commit that adds the baseline.",
      )
      return 1
    }
    console.warn("WARNING: no baseline at the merge base. The raise guard is off.")
    console.warn("  Expected on the commit that first adds the baseline.")
    console.warn("  In CI this fails unless STE_SKIP_BASELINE_GUARD=1.")
    base = undefined
  }
  let working: Baseline | undefined
  try {
    working = readBaseline(BASELINE_PATH)
  } catch {
    working = undefined
  }
  const raised = raisedEntries(next, base, options.introduce, working)
  if (raised.length > 0 && options.introduce.size > 0) {
    // One rule at a time: the other raises are not written and stay red.
    console.log(`Not written (not in --introduce): ${raised.length} entries above their limit.`)
    next = introduceEntries(next, base, options.introduce, working)
  } else if (raised.length > 0) {
    console.error("Refusing to raise the baseline above origin/main:")
    for (const r of raised) {
      const was =
        (
          base?.entries.find((e) => e.file === r.file && e.rule === r.rule) ??
          working?.entries.find((e) => e.file === r.file && e.rule === r.rule)
        )?.count ?? 0
      console.error(`  ${r.file} ${r.rule}: ${r.count} (was ${was})`)
    }
    console.error(
      "Fix the text instead. A NEW rule records its prose debt with --introduce <rule-id>.",
    )
    return 1
  }

  writeBaseline(next, BASELINE_PATH)
  const total = next.reduce((sum, entry) => sum + entry.count, 0)
  console.log(`Wrote ${BASELINE_PATH} with ${total} findings in ${reports.length} files.`)
  const zero = zeroToleranceFindings(reports)
  if (zero.length > 0) {
    console.log(
      `Not written: ${zero.length} zero-tolerance findings (tool block or zero-tolerance rule).`,
    )
  }
  return 0
}

/** Compare with the baseline and return the exit code. */
function gate(options: Options): number {
  const total = printReport(options)
  if (options.dir || options.strict) return total > 0 ? 1 : 0

  if (options.write) return writeMode(options)

  let baseline
  try {
    baseline = readBaseline(BASELINE_PATH)
  } catch {
    console.error(`No baseline at ${BASELINE_PATH}. Run: bun run scripts/ste-check.ts --write`)
    return 1
  }

  const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const reports = reportByFile(surfaces, REPORT_OPTIONS)
  const current = toEntries(reports)
  const worse = [...regressions(current, baseline), ...zeroToleranceRegressions(reports)]
  const better = improvements(current, baseline)

  if (options.report) {
    writeFileSync(resolve(PLUGINS_ROOT, "tests/ste/ste-report.md"), toMarkdown(reports))
  }

  if (better.length > 0) {
    const saved = better.reduce((sum, entry) => sum + entry.count, 0)
    console.log(`\nRatchet: ${better.length} entries are below the baseline. Lower them: --write`)
    console.log(`  (${saved} findings already fixed)`)
  }

  if (worse.length === 0) {
    console.log("\nSTE gate: OK")
    return 0
  }

  console.log(`\nSTE gate: FAIL (${worse.length} regressions)`)
  for (const item of worse) {
    const kind =
      item.reason === "new"
        ? "new rule in this file"
        : item.reason === "zero-tolerance"
          ? "zero tolerance: tool block or a clean rule"
          : "above baseline"
    console.log(`  ${item.file} ${item.rule}: ${item.current} > ${item.baseline} (${kind})`)
  }
  for (const report of reports) {
    for (const finding of report.findings) {
      if (!worse.some((w) => w.file === report.file && w.rule === finding.rule)) continue
      console.log(`    ${formatFinding(report.file, finding)}`)
    }
  }
  return 1
}

const options = parseArgs(process.argv.slice(2))
const code = options.write && !options.dir ? writeMode(options) : gate(options)
process.exit(code)
