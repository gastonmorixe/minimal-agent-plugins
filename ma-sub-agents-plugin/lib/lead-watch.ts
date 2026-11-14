/**
 * Worker-side lead watch: a worker exits by itself when its lead is gone.
 *
 * Only the lead kills a worker today (result sentinel, deadline, StopAgent,
 * `agent.willStop`). All of that lives in the lead process. When the lead dies
 * without cleanup (SIGKILL, crash, OOM), nothing reaps its workers, and they
 * keep running under launchd / init. This module closes that gap from the
 * worker side.
 *
 * The lead stamps its pid as `MINIMAL_AGENT_LEAD_PID` (see `spawn-plan.ts`).
 * In the worker, the `agent.didStart` hook calls {@link startLeadWatchFromEnv}.
 * It polls on an unref'd timer (so it never keeps a worker alive) and exits
 * with code 129 when:
 *   1. `kill(leadPid, 0)` fails with ESRCH (the lead is gone), or
 *   2. the worker was reparented to pid 1 while the lead was its parent
 *      (the lead pid may be reused by an unrelated process).
 *
 * `process.ppid` is a live getter since Bun PR #29171, so case 2 sees the
 * reparent (https://github.com/oven-sh/bun/pull/29171).
 *
 * The lead's own `agent.willStop` SIGKILL path is untouched: this watch only
 * adds a second, worker-side way out.
 *
 * @module sub-agents/lib/lead-watch
 */

/** Env key: the lead's OS pid (stamped by the spawn plan). */
export const ENV_LEAD_PID = "MINIMAL_AGENT_LEAD_PID"
/** Env key: poll interval override in ms (tests use a short value). */
export const ENV_LEAD_WATCH_MS = "MINIMAL_AGENT_LEAD_WATCH_MS"
/** Default poll interval. */
export const DEFAULT_LEAD_WATCH_MS = 2000
/** Lowest allowed poll interval, so a bad env value cannot spin the CPU. */
export const MIN_LEAD_WATCH_MS = 50
/** Exit code when the lead is gone (128 + SIGHUP, the classic "parent hung up"). */
export const LEAD_GONE_EXIT_CODE = 129

/** What one watch tick decides. */
export type LeadVerdict = "alive" | "lead-gone" | "reparented"

/** The inputs of one decision. */
export interface LeadCheck {
  /** The lead pid from the env. */
  readonly leadPid: number
  /** This worker's current parent pid. */
  readonly ppid: number
  /** Result of the `kill(leadPid, 0)` probe. */
  readonly leadAlive: boolean
}

/**
 * Decide if the worker must exit. Pure.
 *
 * `reparented` covers pid reuse: the lead pid exists again, but the worker now
 * hangs off init. A wrapper parent (ppid not the lead and not 1) is `alive`.
 */
export function decideLeadWatch(c: LeadCheck): LeadVerdict {
  if (!c.leadAlive) return "lead-gone"
  if (c.ppid === 1 && c.ppid !== c.leadPid) return "reparented"
  return "alive"
}

/** Parse the lead pid env value. Returns `null` unless it is a positive integer. */
export function parseLeadPid(raw: string | undefined): number | null {
  const s = raw?.trim() ?? ""
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Parse the interval env value. Default {@link DEFAULT_LEAD_WATCH_MS}, floor {@link MIN_LEAD_WATCH_MS}. */
export function parseWatchMs(raw: string | undefined): number {
  const s = raw?.trim() ?? ""
  if (!/^\d+$/.test(s)) return DEFAULT_LEAD_WATCH_MS
  return Math.max(MIN_LEAD_WATCH_MS, Number(s))
}

/**
 * Signal-0 probe. True while `pid` exists. EPERM means it exists but belongs
 * to another user, so it counts as alive. Only ESRCH (or any other error)
 * counts as gone.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"
  }
}

/** Injectable IO for the watch loop (tests stub these). */
export interface LeadWatchDeps {
  readonly isAlive: (pid: number) => boolean
  readonly ppid: () => number
  readonly exit: (code: number) => void
}

/** A running watch. */
export interface LeadWatchHandle {
  readonly leadPid: number
  readonly intervalMs: number
  /** Run one check now. Calls `exit` when the verdict is not `alive`. */
  readonly tick: () => LeadVerdict
  /** Stop the timer. */
  readonly stop: () => void
}

const realDeps: LeadWatchDeps = {
  isAlive: isPidAlive,
  ppid: () => process.ppid,
  exit: (code) => process.exit(code),
}

/** Start a watch on its own unref'd interval. */
export function startLeadWatch(
  leadPid: number,
  intervalMs: number,
  deps: Partial<LeadWatchDeps> = {},
): LeadWatchHandle {
  const d: LeadWatchDeps = { ...realDeps, ...deps }
  const tick = (): LeadVerdict => {
    const verdict = decideLeadWatch({ leadPid, ppid: d.ppid(), leadAlive: d.isAlive(leadPid) })
    if (verdict !== "alive") d.exit(LEAD_GONE_EXIT_CODE)
    return verdict
  }
  const timer = setInterval(tick, intervalMs)
  // Never keep a finished worker alive only for this watch.
  timer.unref?.()
  return { leadPid, intervalMs, tick, stop: () => clearInterval(timer) }
}

let active: LeadWatchHandle | null = null

/**
 * Start the process-wide watch when {@link ENV_LEAD_PID} is set. Idempotent:
 * a second call returns the running watch. Returns `null` in a lead (env
 * unset or invalid).
 *
 * The values are read from `env` first, then both keys are deleted from
 * `scrub` (default `process.env`). Core's Bash tool builds a child env from
 * `process.env` and drops only `BUN_BE_BUN`, so without the delete a CLI that
 * this worker starts from Bash would watch the lead pid, not its own parent.
 * A nested SpawnAgent is not affected: its spawn plan stamps this worker's
 * pid. Only an explicit env sees the delete: a `Bun.spawn` with no `env`
 * option uses `process.env` as it was at launch
 * (https://bun.com/reference/bun/spawn).
 */
export function startLeadWatchFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: Partial<LeadWatchDeps> = {},
  scrub: Record<string, string | undefined> = process.env,
): LeadWatchHandle | null {
  const rawPid = env[ENV_LEAD_PID]
  const rawMs = env[ENV_LEAD_WATCH_MS]
  delete scrub[ENV_LEAD_PID]
  delete scrub[ENV_LEAD_WATCH_MS]
  if (active) return active
  const leadPid = parseLeadPid(rawPid)
  if (leadPid === null) return null
  active = startLeadWatch(leadPid, parseWatchMs(rawMs), deps)
  return active
}

/** The running process-wide watch, or `null`. */
export function activeLeadWatch(): LeadWatchHandle | null {
  return active
}

/** Stop and clear the process-wide watch (tests). */
export function stopActiveLeadWatch(): void {
  active?.stop()
  active = null
}
