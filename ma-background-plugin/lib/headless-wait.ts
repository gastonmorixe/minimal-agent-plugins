/**
 * The headless keep-alive of the background jobs: the logic of the
 * `turn.willStop` hook (`handlers/on_turn_will_stop.ts`).
 *
 * A headless run (`-p`, `stream-json`, a sub-agent worker) has no live area,
 * so the heartbeat never runs and no digest comes between turns. When such a
 * run ends its turn while its own jobs run, the process exits and the runner
 * kills the jobs. This module waits (bounded) for the running jobs of the
 * session, then gives a halt with their digests, so the model gets one more
 * round to read the output.
 *
 * Every collaborator (reconcile pass, clock, sleep, signals) is injected, so
 * the wait is unit-testable with no real process and no real timer.
 *
 * @module lib/headless-wait
 */

import { formatDuration } from "./duration.ts"
import type { RunFact } from "./host-types.ts"
import type { Effect } from "./reconcile.ts"
import type { JobRecord } from "./types.ts"

/** Env: `0` disables the headless wait. */
export const ENV_HEADLESS_WAIT = "MINIMAL_AGENT_BG_HEADLESS_WAIT"
/** Env: the longest total wait of one turn, in ms. */
export const ENV_HEADLESS_WAIT_MS = "MINIMAL_AGENT_BG_HEADLESS_WAIT_MS"
/** Default longest total wait of one turn: 20 min. */
export const DEFAULT_HEADLESS_WAIT_MS = 20 * 60_000
/**
 * Upper clamp of {@link ENV_HEADLESS_WAIT_MS}. The manifest `timeoutMs` of the
 * hook (25 min) must stay above it, or the bus allows the stop early.
 */
export const MAX_HEADLESS_WAIT_MS = 24 * 60_000
/** The hook stops waiting this long before the sub-agent budget deadline. */
export const BUDGET_MARGIN_MS = 60_000
/** Poll period of the reconcile pass. */
export const POLL_MS = 1000
/** Most digest lines in one halt reason. */
export const MAX_DIGEST_LINES = 10

export type { RunFact } from "./host-types.ts"

/** The modes where a stop can end the process. `host` and `repl` are excluded. */
const HEADLESS_MODES: ReadonlySet<string> = new Set(["one-shot", "stream-json", "subagent"])

/**
 * True when this run is headless and a stop can end the process. With a run
 * fact: `interactive === false` and a mode in {@link HEADLESS_MODES}. Without
 * one (an older host): a worker id in the payload, or a non-empty
 * `MINIMAL_AGENT_WRAP_UP_TOOLS` (set for each sub-agent worker).
 */
export function isHeadlessRun(
  run: RunFact | undefined,
  payload: { readonly agentId?: string } | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (run) return run.interactive === false && HEADLESS_MODES.has(run.mode)
  if (payload?.agentId?.trim()) return true
  return (env.MINIMAL_AGENT_WRAP_UP_TOOLS ?? "").trim().length > 0
}

/** True when the env disables the wait (or the whole plugin). */
export function waitDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.MINIMAL_AGENT_DISABLE_BGJOBS === "1" || env[ENV_HEADLESS_WAIT]?.trim() === "0"
}

/** The longest total wait of one turn from the env, clamped to {@link MAX_HEADLESS_WAIT_MS}. */
export function maxWaitMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[ENV_HEADLESS_WAIT_MS]?.trim()
  const n = raw ? Number(raw) : Number.NaN
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HEADLESS_WAIT_MS
  return Math.min(Math.floor(n), MAX_HEADLESS_WAIT_MS)
}

/**
 * The sub-agent budget deadline (epoch ms) minus {@link BUDGET_MARGIN_MS},
 * from `MINIMAL_AGENT_SUBAGENT_BUDGET` (`{deadlineSec}`) and
 * `MINIMAL_AGENT_SUBAGENT_STARTED_AT` (ISO). `undefined` when not a worker
 * or when a value is bad.
 */
export function budgetDeadlineMs(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env.MINIMAL_AGENT_SUBAGENT_BUDGET?.trim()
  const startedAt = Date.parse(env.MINIMAL_AGENT_SUBAGENT_STARTED_AT ?? "")
  if (!raw || !Number.isFinite(startedAt)) return undefined
  try {
    const sec = (JSON.parse(raw) as { deadlineSec?: unknown }).deadlineSec
    if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return undefined
    return startedAt + sec * 1000 - BUDGET_MARGIN_MS
  } catch {
    return undefined
  }
}

/**
 * The wait deadline (epoch ms): the smaller of the max wait and the budget
 * deadline. `waitedMs` is the wait that this turn already used: the max wait
 * is a total for the turn, not a value for each stop.
 */
export function waitDeadlineMs(
  env: Readonly<Record<string, string | undefined>>,
  nowMs: number,
  waitedMs = 0,
): number {
  const byWait = nowMs + Math.max(0, maxWaitMs(env) - waitedMs)
  const byBudget = budgetDeadlineMs(env)
  return byBudget === undefined ? byWait : Math.min(byWait, byBudget)
}

/** One reconcile pass, as the hook sees it. */
export interface Pass {
  readonly records: readonly JobRecord[]
  readonly effects: readonly Effect[]
}

/** Injected collaborators of {@link waitForJobs}. */
export interface WaitDeps {
  /** One reconcile pass (persists the store as a side effect). */
  readonly reconcile: () => Pass
  /** Epoch ms. */
  readonly now: () => number
  /** Resolve after `ms`, or at once when `signal` aborts. Must not keep the process alive. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Aborts when the wait must end at once (hook abort, SIGTERM, SIGINT). */
  readonly signal: AbortSignal
}

/** The result of {@link waitForJobs}. */
export interface WaitOutcome {
  /** Digest text per job id, for jobs that ended and that no one reported. */
  readonly finished: ReadonlyMap<string, string>
  /** Ids of the jobs that still run at the end of the wait. */
  readonly running: readonly string[]
  /** True when the wait ended because the deadline came. */
  readonly deadlineHit: boolean
  /** True when the signal aborted the wait. */
  readonly aborted: boolean
  /** The wait time, in ms. */
  readonly waitedMs: number
  /** True when the wait slept at least once (a job ran at the first pass). */
  readonly waited: boolean
}

/** Ids of the records that still run. */
export function runningIds(records: readonly JobRecord[]): string[] {
  return records.filter((r) => r.status.kind === "running").map((r) => r.id)
}

/** Collect the `inject` digests of a pass into `into` (by job id). */
function collect(effects: readonly Effect[], into: Map<string, string>): void {
  for (const e of effects) {
    if (e.type !== "inject") continue
    const id = e.source.startsWith("bgjob:") ? e.source.slice("bgjob:".length) : e.source
    into.set(id, e.text)
  }
}

/**
 * Poll the reconcile pass until no job of the session runs, the deadline
 * comes, or the signal aborts. The first pass runs at once (no sleep). The
 * `inject` effects of each pass are the jobs that ended and that no one
 * reported (a BackgroundStatus call reports in its own result).
 */
export async function waitForJobs(deps: WaitDeps, deadlineAt: number): Promise<WaitOutcome> {
  const start = deps.now()
  const finished = new Map<string, string>()
  let pass = deps.reconcile()
  collect(pass.effects, finished)
  let running = runningIds(pass.records)
  let waited = false
  while (running.length > 0 && !deps.signal.aborted && deps.now() < deadlineAt) {
    waited = true
    await deps.sleep(Math.min(POLL_MS, Math.max(0, deadlineAt - deps.now())), deps.signal)
    if (deps.signal.aborted) break
    pass = deps.reconcile()
    collect(pass.effects, finished)
    running = runningIds(pass.records)
  }
  const aborted = deps.signal.aborted
  return {
    finished,
    running,
    deadlineHit: !aborted && running.length > 0,
    aborted,
    waitedMs: Math.max(0, deps.now() - start),
    waited,
  }
}

/** The first line of a halt after a wait: the turn did not stop. */
export const HALT_WAITED =
  "The run did not stop, because background jobs of this run were not complete."
/** The first line of a halt with no wait: the jobs were complete before the stop. */
export const HALT_COMPLETE = "Background jobs of this run are complete."

/**
 * The text for the jobs that still run at the deadline (ASD-STE100), with a
 * singular and a plural form. `waitedMs` is the total wait of this turn.
 */
export function stillRunningText(ids: readonly string[], waitedMs: number): string {
  const after = formatDuration(waitedMs)
  if (ids.length === 1) {
    return (
      `Job ${ids[0]} continues to run after ${after}. When this turn stops, the job stops. ` +
      "Stop it with BackgroundStop, or read its output with BackgroundLogs, then complete the task."
    )
  }
  return (
    `Jobs ${ids.join(", ")} continue to run after ${after}. When this turn stops, the jobs stop. ` +
    "Stop them with BackgroundStop, or read their output with BackgroundLogs, then complete the task."
  )
}

/**
 * The halt reason (ASD-STE100). It names each finished job (at most
 * {@link MAX_DIGEST_LINES} lines) and each job that still runs.
 * `totalWaitedMs` (default: the wait of this outcome) is the total wait of
 * the turn, for the "continues to run" text.
 */
export function haltReason(o: WaitOutcome, totalWaitedMs: number = o.waitedMs): string {
  const lines: string[] = []
  const digests = [...o.finished.values()]
  if (digests.length > 0) {
    // With no wait and no running job, the jobs were complete before the stop.
    lines.push(!o.waited && o.running.length === 0 ? HALT_COMPLETE : HALT_WAITED)
    lines.push(...digests.slice(0, MAX_DIGEST_LINES))
    if (digests.length > MAX_DIGEST_LINES) {
      lines.push(`And ${digests.length - MAX_DIGEST_LINES} more jobs are complete.`)
    }
  }
  if (o.running.length > 0) lines.push(stillRunningText(o.running, totalWaitedMs))
  if (digests.length > 0) lines.push("Read the output with BackgroundLogs, then continue the task.")
  return lines.join("\n")
}

/** A stable key of the state at a halt, for the loop guard. */
export function stateKey(running: readonly string[]): string {
  return [...running].sort().join(",")
}
