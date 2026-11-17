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
 *                                             # let a NEW rule id record its prose debt
 *   bun run scripts/ste-check.ts --init-lock  # write the first lock (refused once one is committed)
 *   bun run scripts/ste-check.ts --strict     # fail on any finding, no baseline
 *   bun run scripts/ste-check.ts --dir <p>    # gate one other tree, no baseline
 *
 * A finding in the tool block (role `tool` or `param`) and a finding of a
 * zero-tolerance rule never enter the baseline. The gate fails on each one.
 *
 * The ceiling of every write is the committed lock `tests/ste/ratchet-lock.json`
 * (see `RatchetLock` in `tests/ste/ratchet.ts`), never the merge base. A write
 * refuses to go above it, and `--write` writes the lower counts back to it.
 * The gate also fails when the tree (baseline or s19 pending counts) is above
 * the lock, or when the lock is above an earlier committed copy.
 *
 * Extra rules (s19 dictionary, s20 tool names) live in
 * `tests/ste/extra-rules.ts`. The gate loads that module only when it exists.
 * Its default export has the `ExtraFindings` signature of `ste-rules.ts`.
 *
 * @module scripts/ste-check
 */

import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { readDictionaryData } from "../tests/ste/dictionary.ts"
import {
  BASELINE_PATH,
  entriesToCounts,
  type FileReport,
  formatFinding,
  headRuleIds,
  improvements,
  introduceEntries,
  introduceRefusal,
  knownRules,
  LOCK_PATH,
  lockBaseline,
  lockCeiling,
  lockHistory,
  lockProblems,
  lockRaises,
  type RatchetLock,
  type ReportOptions,
  raisedEntries,
  readBaseline,
  readLock,
  regressions,
  reportByFile,
  toEntries,
  toMarkdown,
  writeBaseline,
  writeLock,
  ZERO_TOLERANCE,
  zeroToleranceFindings,
  zeroToleranceRegressions,
} from "../tests/ste/ratchet.ts"
import { type ExtraFindings, RULE_IDS } from "../tests/ste/ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "../tests/ste/surfaces.ts"

import { livePendingCounts, pendingAdditions, pendingKeys } from "./ste-dict.ts"

interface Options {
  write: boolean
  initLock: boolean
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
    const mod = (await import(EXTRA_RULES)) as {
      default?: unknown
      isVerb?: unknown
      handlerMessageReports?: unknown
    }
    if (typeof mod.default !== "function") {
      // The file exists, so its rules are expected. Turning them off with a
      // warning would pass s19/s20 debt in silence.
      console.error(`STE: ${EXTRA_RULES} has no default export function.`)
      process.exit(2)
    }
    const isVerb =
      typeof mod.isVerb === "function" ? (mod.isVerb as (word: string) => boolean) : undefined
    // REVIEW-C M1: the s20 check of human text in plugin handler code must be
    // part of the gate, not only of a test.
    if (typeof mod.handlerMessageReports !== "function") {
      console.error(`STE: ${EXTRA_RULES} has no handlerMessageReports export.`)
      process.exit(2)
    }
    const handlers = mod.handlerMessageReports as () => FileReport[]
    return { extraFindings: mod.default as ExtraFindings, isVerb, extraReports: () => handlers() }
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
  const options: Options = {
    write: false,
    initLock: false,
    report: false,
    strict: false,
    introduce: new Set(),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--write") options.write = true
    else if (arg === "--init-lock") options.initLock = true
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
  // Count EVERY finding (REVIEW-C2 N0). `toEntries` skips zero-tolerance
  // findings (they never enter the baseline), so a total from it is 0 when
  // every rule is zero-tolerance, and --strict would exit 0 on a finding.
  const perRule = new Map<string, number>()
  for (const report of reports) {
    for (const finding of report.findings) {
      perRule.set(finding.rule, (perRule.get(finding.rule) ?? 0) + 1)
    }
  }
  const total = [...perRule.values()].reduce((sum, count) => sum + count, 0)

  console.log(`STE surfaces: ${surfaces.length}`)
  console.log(`Files with findings: ${reports.length}`)
  console.log(`Findings: ${total}`)

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

/**
 * Read the lock, or print why the run cannot go on. There is no first-landing
 * path: a missing lock is an error, so a deleted lock cannot open the ratchet.
 */
function lockOrError(): RatchetLock | undefined {
  try {
    return readLock(LOCK_PATH)
  } catch (error) {
    console.error(
      `STE: cannot read ${LOCK_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    )
    console.error("  The lock is the ceiling of the ratchet. Restore it from git.")
    return undefined
  }
}

/**
 * Every way the tree or the lock is above the ratchet: a bad lock shape, a
 * rule that left ZERO_TOLERANCE, the lock above a committed copy, the tree
 * above the lock, and the s19 pending counts above the lock.
 *
 * @param lock - The working lock.
 * @param current - Today's entries.
 * @returns One line per problem.
 */
function lockFailures(lock: RatchetLock, current: ReturnType<typeof toEntries>): string[] {
  const out: string[] = lockProblems(lock).map((line) => `lock: ${line}`)
  for (const rule of lock.zeroTolerance) {
    if (!ZERO_TOLERANCE.has(rule)) out.push(`ZERO_TOLERANCE lost ${rule} (the lock pins it)`)
  }
  for (const { ref, lock: prev } of lockHistory()) {
    for (const line of lockRaises(lock, prev)) out.push(`lock above ${ref.slice(0, 10)}: ${line}`)
  }
  const ceiling = lockBaseline(lock)
  for (const r of regressions(current, ceiling)) {
    out.push(`tree above lock: ${r.rule} @ ${r.file}: ${r.current} > ${r.baseline}`)
  }
  for (const line of pendingAdditions(livePendingCounts(), lock.pending)) {
    out.push(`s19 pending above lock: ${line}`)
  }
  return out
}

/**
 * Write the first lock. Refused when HEAD, the merge base or any commit since
 * has a lock: after the lock lands, only the write commands lower it. The
 * first lock pins only debt that is already recorded: the tree must not be
 * above `ste-baseline.json`, and every pending pair must be in `pending.json`.
 */
function initLockMode(): number {
  const history = lockHistory()
  if (history.length > 0) {
    console.error(`--init-lock: refused, ${LOCK_PATH} is committed at ${history[0]?.ref}.`)
    console.error(
      "  Lower it with ste:write or ste:dict --write-pending. A raise is never allowed.",
    )
    return 1
  }
  const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const reports = reportByFile(surfaces, REPORT_OPTIONS)
  const current = toEntries(reports)
  const above = regressions(current, readBaseline(BASELINE_PATH))
  const counts = livePendingCounts()
  const recorded = new Set(pendingKeys(readDictionaryData().pending))
  const unrecorded = Object.keys(counts).filter((key) => !recorded.has(key))
  if (above.length > 0 || unrecorded.length > 0) {
    console.error("--init-lock: refused, the tree is above the recorded debt:")
    for (const r of above) console.error(`  ${r.file} ${r.rule}: ${r.current} > ${r.baseline}`)
    for (const key of unrecorded) console.error(`  pending: ${key} is not in pending.json`)
    return 1
  }
  writeLock({
    version: 1,
    rules: [...RULE_IDS],
    zeroTolerance: [...ZERO_TOLERANCE],
    baseline: entriesToCounts(current),
    pending: counts,
  })
  console.log(`Wrote ${LOCK_PATH}. Commit it: from now on it only goes down.`)
  return 0
}

/** Record today's counts, but never above the lock. */
function writeMode(options: Options): number {
  if (options.dir) {
    console.error("--write needs the repo tree. Do not give --dir.")
    return 2
  }
  const working = lockOrError()
  if (!working) return 2
  // The ceiling is the lowest of the working lock and every committed copy,
  // so a hand raise of the lock file does not raise the ceiling.
  const ceiling = lockCeiling(working, lockHistory())
  const known = knownRules(ceiling, headRuleIds())
  for (const rule of options.introduce) {
    const refusal = introduceRefusal(rule, known, RULE_IDS)
    if (refusal) {
      console.error(`--introduce: refused: ${refusal}`)
      return 2
    }
  }
  const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const reports = reportByFile(surfaces, REPORT_OPTIONS)
  // Tool-role, param-role and zero-tolerance findings are never written.
  let next = toEntries(reports)

  // A raise is a merge failure, not a review miss. Without this, a bad edit
  // plus `ste:write` makes the gate green.
  const limit = lockBaseline(ceiling)
  const raised = raisedEntries(next, limit, options.introduce, known)
  if (raised.length > 0 && options.introduce.size > 0) {
    // One rule at a time: the other raises are not written and stay red.
    console.log(`Not written (not in --introduce): ${raised.length} entries above their limit.`)
    next = introduceEntries(next, limit, options.introduce, known)
  } else if (raised.length > 0) {
    console.error(`Refusing to raise the baseline above the lock (${LOCK_PATH}):`)
    for (const r of raised) {
      const was = limit.entries.find((e) => e.file === r.file && e.rule === r.rule)?.count ?? 0
      console.error(`  ${r.file} ${r.rule}: ${r.count} (was ${was})`)
    }
    console.error(
      "Fix the text instead. A NEW rule id records its prose debt with --introduce <rule-id>.",
    )
    return 1
  }

  writeBaseline(next, BASELINE_PATH)
  writeLock({
    version: 1,
    rules: [...ceiling.rules, ...RULE_IDS],
    zeroTolerance: [...ceiling.zeroTolerance, ...ZERO_TOLERANCE],
    baseline: entriesToCounts(next),
    pending: ceiling.pending,
  })
  const total = next.reduce((sum, entry) => sum + entry.count, 0)
  console.log(`Wrote ${BASELINE_PATH} with ${total} findings in ${reports.length} files.`)
  console.log(`Wrote ${LOCK_PATH}.`)
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
  const lock = lockOrError()
  if (!lock) return 1
  const lockBad = lockFailures(lock, current)

  if (options.report) {
    writeFileSync(resolve(PLUGINS_ROOT, "tests/ste/ste-report.md"), toMarkdown(reports))
  }

  if (better.length > 0) {
    const saved = better.reduce((sum, entry) => sum + entry.count, 0)
    console.log(`\nRatchet: ${better.length} entries are below the baseline. Lower them: --write`)
    console.log(`  (${saved} findings already fixed)`)
  }

  if (lockBad.length > 0) {
    console.log(`\nSTE gate: FAIL (${lockBad.length} ratchet lock problems)`)
    for (const line of lockBad) console.log(`  ${line}`)
    if (worse.length === 0) return 1
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
const code = options.initLock
  ? initLockMode()
  : options.write && !options.dir
    ? writeMode(options)
    : gate(options)
process.exit(code)
