/**
 * Soft budget warnings for a sub-agent worker (Design A). Pure logic.
 *
 * The lead gives the worker its effective budget and its start time in the
 * env ({@link ENV_BUDGET}, {@link ENV_STARTED_AT}). The worker-side stamp
 * stage (`handlers/budget_transforms.ts`) asks {@link nextBudgetWarning} at
 * each tool result. When the time or the turn count crosses a threshold, the
 * stage adds one `budget` annotation to that tool result:
 *
 *  - `warn`: 75 % of the deadline, or
 *    `turnsLeft <= min(max(3, ceil(10 % of maxTurns)), floor(maxTurns / 2))`.
 *  - `final`: 90 % of the deadline, or `turnsLeft <= 1` when `maxTurns > 2`
 *    (a budget of 1 or 2 turns gets no turn-based `final`).
 *
 * Each level fires once (a latch). A jump straight to `final` skips `warn`.
 * No budget env (a lead, or a worker of an old lead) gives `null` always.
 *
 * @module sub-agents/lib/budget-warning
 */

import { ENV_BUDGET, ENV_STARTED_AT, REPORT_RESULT_TOOL } from "./spawn.ts"
import { effectiveDeadlineSec } from "./supervisor.ts"
import type { Budget } from "./types.ts"

/** A warning level. `final` is the stronger one. */
export type BudgetLevel = "warn" | "final"

/** The budget of the worker, as the lead gave it in {@link ENV_BUDGET}. */
export interface WorkerBudget {
  /** Effective deadline in seconds (explicit, else the supervisor default). */
  readonly deadlineSec: number
  /** Max model responses, when the lead set it. */
  readonly maxTurns?: number
  /** Max generated tokens, when the lead set it. Not used for a warning. */
  readonly maxTokens?: number
}

/** The facts of one warning: the attrs of the `budget` tag. */
export interface BudgetWarning {
  readonly level: BudgetLevel
  /** Seconds since the lead start. */
  readonly elapsed: number
  /** Seconds to the deadline (0 when past it). */
  readonly remaining: number
  /** Turns that stay before the supervisor stop, when `maxTurns` is set. */
  readonly turnsLeft?: number
}

/** Fraction of the deadline that gives `warn`. */
export const WARN_TIME_FRACTION = 0.75
/** Fraction of the deadline that gives `final`. */
export const FINAL_TIME_FRACTION = 0.9

/** The tag body for each level (ASD-STE100, checked by the STE dictionary). */
export const BUDGET_TEXT: Readonly<Record<BudgetLevel, string>> = Object.freeze({
  warn: `You used most of your time or turns. Complete your work quickly. Then use ${REPORT_RESULT_TOOL}.`,
  final: `You are near the limit of your time or turns. Stop your work at this time. Use ${REPORT_RESULT_TOOL} with the results that you have. Tell which work is not complete.`,
})

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * Build the budget env for one worker. The lead calls it before the launch.
 *
 * @param budget - The budget of the spawn request, if any.
 * @param startedAtIso - The lead clock before the launch.
 * @returns The two env entries.
 */
export function budgetEnv(
  budget: Budget | undefined,
  startedAtIso: string,
): Record<string, string> {
  const value: WorkerBudget = {
    deadlineSec: effectiveDeadlineSec({ ...(budget ? { budget } : {}) }),
    ...(positive(budget?.maxTurns) ? { maxTurns: budget.maxTurns } : {}),
    ...(positive(budget?.maxTokens) ? { maxTokens: budget.maxTokens } : {}),
  }
  return { [ENV_BUDGET]: JSON.stringify(value), [ENV_STARTED_AT]: startedAtIso }
}

/**
 * Read the budget and the start time from the env.
 *
 * @param env - The worker env.
 * @returns The budget and the start (epoch ms), or `null` when absent or bad.
 */
export function readBudgetEnv(
  env: Readonly<Record<string, string | undefined>>,
): { budget: WorkerBudget; startedAtMs: number } | null {
  const raw = env[ENV_BUDGET]?.trim()
  const startedAtMs = Date.parse(env[ENV_STARTED_AT] ?? "")
  if (!raw || !Number.isFinite(startedAtMs)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (!positive(o.deadlineSec)) return null
  return {
    budget: {
      deadlineSec: o.deadlineSec,
      ...(positive(o.maxTurns) ? { maxTurns: Math.floor(o.maxTurns) } : {}),
      ...(positive(o.maxTokens) ? { maxTokens: o.maxTokens } : {}),
    },
    startedAtMs,
  }
}

/**
 * The turns that stay before the supervisor stop. The supervisor stops the
 * worker when turn `maxTurns + 1` starts, so turn `maxTurns` is the last one.
 *
 * @param turnsUsed - The newest started turn (1-based).
 * @param maxTurns - The turn limit.
 * @returns `maxTurns - turnsUsed`, never below 0.
 */
export function turnsLeftOf(turnsUsed: number, maxTurns: number): number {
  return Math.max(0, maxTurns - turnsUsed)
}

/** The facts that {@link budgetLevel} reads. */
export interface BudgetFacts {
  /** Time since the start, in ms. */
  readonly elapsedMs: number
  /** The deadline, in ms. */
  readonly deadlineMs: number
  /** The newest started turn (1-based). */
  readonly turnsUsed: number
  /** The turn limit, if set. */
  readonly maxTurns?: number
  /** Generated output tokens so far, if known. */
  readonly outputTokens?: number
  /** The token limit, if set. */
  readonly maxTokens?: number
}

/**
 * The level for the facts at this time, with no latch. Pure.
 *
 * @param f - The facts at this time.
 * @returns `final`, `warn` or `null`.
 */
export function budgetLevel(f: BudgetFacts): BudgetLevel | null {
  const frac = f.deadlineMs > 0 ? f.elapsedMs / f.deadlineMs : 0
  const tokFrac =
    positive(f.maxTokens) && typeof f.outputTokens === "number" && f.outputTokens > 0
      ? f.outputTokens / f.maxTokens
      : 0
  const left = positive(f.maxTurns) ? turnsLeftOf(f.turnsUsed, f.maxTurns) : undefined
  const max = positive(f.maxTurns) ? f.maxTurns : 0
  // A small turn budget gives no turn-based `final` (maxTurns <= 2), and the
  // turn-based `warn` comes at most at half of the budget (no noise at turn 1).
  if (
    frac >= FINAL_TIME_FRACTION ||
    tokFrac >= FINAL_TIME_FRACTION ||
    (left !== undefined && left <= 1 && max > 2)
  )
    return "final"
  const warnTurns = Math.min(Math.max(3, Math.ceil(max * 0.1)), Math.floor(max / 2))
  if (
    frac >= WARN_TIME_FRACTION ||
    tokFrac >= WARN_TIME_FRACTION ||
    (left !== undefined && left <= warnTurns)
  )
    return "warn"
  return null
}

const RANK: Readonly<Record<BudgetLevel, number>> = { warn: 1, final: 2 }

/** The once-per-level latch: the highest level already given. */
export interface BudgetLatch {
  last: BudgetLevel | null
}

/** A new latch with no level given. */
export function createLatch(): BudgetLatch {
  return { last: null }
}

/**
 * The warning to give now, or `null`. It changes the latch: each level is
 * given once, and a lower level never comes after a higher one.
 *
 * @param env - The worker env.
 * @param nowMs - Epoch ms at this time.
 * @param turnsUsed - The newest started turn (1-based, 0 when unknown).
 * @param latch - The latch of this process.
 * @returns The warning facts, or `null`.
 */
export function nextBudgetWarning(
  env: Readonly<Record<string, string | undefined>>,
  nowMs: number,
  turnsUsed: number,
  latch: BudgetLatch,
  outputTokens?: number,
): BudgetWarning | null {
  const read = readBudgetEnv(env)
  if (!read) return null
  const { budget, startedAtMs } = read
  const elapsedMs = Math.max(0, nowMs - startedAtMs)
  const deadlineMs = budget.deadlineSec * 1000
  const level = budgetLevel({
    elapsedMs,
    deadlineMs,
    turnsUsed,
    ...(budget.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  })
  if (!level) return null
  if (latch.last && RANK[latch.last] >= RANK[level]) return null
  latch.last = level
  return {
    level,
    elapsed: Math.floor(elapsedMs / 1000),
    remaining: Math.max(0, Math.ceil((deadlineMs - elapsedMs) / 1000)),
    ...(budget.maxTurns !== undefined
      ? { turnsLeft: turnsLeftOf(turnsUsed, budget.maxTurns) }
      : {}),
  }
}
