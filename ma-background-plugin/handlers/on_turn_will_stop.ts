/**
 * `turn.willStop` hook: in a headless run, do not let the turn end while the
 * jobs of this session run.
 *
 * Thin shell over `lib/headless-wait.ts`: detect a headless run, build the
 * real deps, wait (bounded) for the running jobs, then halt with their
 * digests so the model gets one more round. In an interactive run it does
 * nothing (the heartbeat injects the digest between turns there).
 *
 * The wait stops at once on the hook abort (`ctx.abort`: the bus dispose
 * signal merged with the turn signal on a core that gives it) and on
 * SIGTERM / SIGINT / SIGHUP. The signal listener has the fan-out tag
 * (`Symbol.for("minimal-agent.signal-fanout")`), so it never counts as the
 * owner of the signal. The timers of this hook are unref'd.
 *
 * The max wait (`MINIMAL_AGENT_BG_HEADLESS_WAIT_MS`) is a total for each turn
 * and session, not a value for each stop. Thus a job that never ends holds
 * the turn for about one max wait, also when the model starts more jobs or
 * when another job ends during the extra round. The total resets on the
 * first stop of a turn and on an allow with no running job.
 *
 * Opt out: `MINIMAL_AGENT_BG_HEADLESS_WAIT=0` or `MINIMAL_AGENT_DISABLE_BGJOBS=1`.
 *
 * @module handlers/on_turn_will_stop
 */

import { loadBgConfig } from "../lib/config.ts"
import { realReconcileIO, serviceDepsFromCtx } from "../lib/handler-deps.ts"
import {
  haltReason,
  isHeadlessRun,
  type Pass,
  type RunFact,
  runningIds,
  stateKey,
  type WaitDeps,
  waitDeadlineMs,
  waitDisabled,
  waitForJobs,
} from "../lib/headless-wait.ts"
import type { AgentContext } from "../lib/host-types.ts"
import { runReconcile } from "../lib/service.ts"

/** The `turn.willStop` payload fields this hook reads. */
export interface TurnWillStopPayload {
  readonly stopHookActive?: boolean
  readonly agentId?: string
  readonly sid?: string
}

/** The hook context fields this hook reads (mirror of core `HookHandlerContext`). */
export interface StopHookContext {
  readonly packageDir: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly abort: AbortSignal
  readonly agent?: AgentContext
  readonly run?: RunFact
}

/** A halt of the stop chain. */
export interface StopHalt {
  readonly halt: true
  readonly reason: string
}

/** Test seams: replace the reconcile pass, the clock, the sleep and the signal source. */
export interface StopHookSeams {
  readonly reconcile?: () => Pass
  readonly now?: () => number
  readonly sleep?: WaitDeps["sleep"]
  readonly signals?: Pick<NodeJS.Process, "on" | "off" | "listeners" | "kill" | "pid">
}

/** The fan-out tag of core `plugin-api/utils/file-lock.ts` (`SIGNAL_FANOUT`). */
const FANOUT: unique symbol = Symbol.for("minimal-agent.signal-fanout")

/** A signal listener that may carry the {@link FANOUT} tag. */
type FanOutListener = ((...args: unknown[]) => void) & { [FANOUT]?: true }

/**
 * The signals that end the wait: the same set as the registry fan-out
 * (`PARENT_EXIT_SIGNALS` in `lib/registry.ts`).
 */
const WAIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const

/**
 * The running set at the last halt that came from the deadline, per session.
 * The loop guard: a new stop with `stopHookActive` and the same running set
 * is allowed, so a job that never ends cannot hold the turn for ever.
 */
const deadlineHalts = new Map<string, string>()

/** The total wait (ms) of the current turn, per session. */
const waitedTotal = new Map<string, number>()

/** Test seam: forget the loop-guard state and the wait totals. */
export function resetForTests(): void {
  deadlineHalts.clear()
  waitedTotal.clear()
}

/** Resolve after `ms` or when `signal` aborts. The timer is unref'd. */
export function unrefSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const t = setTimeout(done, ms)
    t.unref?.()
    signal.addEventListener("abort", done, { once: true })
  })
}

/** Number of listeners for `sig` that are not a fan-out (they own the exit). */
function ownerCount(src: NonNullable<StopHookSeams["signals"]>, sig: NodeJS.Signals): number {
  return src.listeners(sig).filter((l) => (l as FanOutListener)[FANOUT] !== true).length
}

/**
 * Abort `ac` on SIGTERM / SIGINT / SIGHUP. Each listener has the fan-out tag.
 * When it fires, it removes itself. If no owner (a listener with no fan-out
 * tag) exists for that signal, it raises the signal again, so the default
 * action (end the process) runs when the last fan-out is gone. This is the
 * rule of the other fan-outs (registry, ma-speak, file-lock). Another fan-out
 * can also raise the signal in the same emit. That is harmless: the first
 * raise ends the process. Gives a function that removes the listeners that
 * did not fire.
 */
function linkSignals(ac: AbortController, src: NonNullable<StopHookSeams["signals"]>): () => void {
  const installed = new Map<string, () => void>()
  for (const sig of WAIT_SIGNALS) {
    const listener: FanOutListener = (): void => {
      const owners = ownerCount(src, sig)
      ac.abort()
      src.off(sig, listener)
      installed.delete(sig)
      if (owners === 0) src.kill(src.pid, sig)
    }
    listener[FANOUT] = true
    installed.set(sig, listener)
    src.on(sig, listener)
  }
  return () => {
    for (const [sig, l] of installed) src.off(sig, l)
    installed.clear()
  }
}

/** Build the real reconcile pass for the session, or `null` with no session id. */
function realReconcile(ctx: StopHookContext): (() => Pass) | null {
  const deps = serviceDepsFromCtx(
    {
      packageDir: ctx.packageDir,
      cwd: ctx.cwd,
      env: ctx.env,
      ...(ctx.agent ? { agent: ctx.agent } : {}),
    },
    loadBgConfig(ctx.env as NodeJS.ProcessEnv),
  )
  if (!deps) return null
  return () => runReconcile(deps, realReconcileIO())
}

/** The hook handler, with test seams. */
export async function onTurnWillStop(
  payload: TurnWillStopPayload | undefined,
  ctx: StopHookContext,
  seams: StopHookSeams = {},
): Promise<StopHalt | undefined> {
  if (!isHeadlessRun(ctx.run, payload, ctx.env)) return undefined
  if (waitDisabled(ctx.env)) return undefined
  const reconcile = seams.reconcile ?? realReconcile(ctx)
  if (!reconcile) return undefined
  const key = ctx.agent?.sessionId ?? payload?.sid ?? ""
  const now = seams.now ?? Date.now
  // The first stop of a turn starts a new wait total.
  if (payload?.stopHookActive !== true) waitedTotal.delete(key)

  const first = reconcile()
  const firstInject = first.effects.some((e) => e.type === "inject")
  const firstRunning = runningIds(first.records)
  if (!firstInject && firstRunning.length === 0) {
    deadlineHalts.delete(key)
    waitedTotal.delete(key)
    return undefined
  }
  // The loop guard: nothing changed since the last deadline halt.
  if (
    payload?.stopHookActive === true &&
    !firstInject &&
    deadlineHalts.get(key) === stateKey(firstRunning)
  ) {
    deadlineHalts.delete(key)
    return undefined
  }

  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  if (ctx.abort.aborted) ac.abort()
  else ctx.abort.addEventListener("abort", onAbort, { once: true })
  const unlink = linkSignals(ac, seams.signals ?? process)
  let used = false
  const before = waitedTotal.get(key) ?? 0
  let waitedMs = 0
  try {
    const outcome = await waitForJobs(
      {
        // The first pass already ran: give it back once, then poll.
        reconcile: () => {
          if (used) return reconcile()
          used = true
          return first
        },
        now,
        sleep: seams.sleep ?? unrefSleep,
        signal: ac.signal,
      },
      // The max wait is a total for the turn: subtract the earlier waits.
      waitDeadlineMs(ctx.env, now(), before),
    )
    waitedMs = outcome.waitedMs
    if (outcome.aborted) return undefined
    if (outcome.deadlineHit) deadlineHalts.set(key, stateKey(outcome.running))
    else deadlineHalts.delete(key)
    const reason = haltReason(outcome, before + outcome.waitedMs)
    return reason ? { halt: true, reason } : undefined
  } finally {
    waitedTotal.set(key, before + waitedMs)
    unlink()
    ctx.abort.removeEventListener("abort", onAbort)
  }
}

const handler = (payload: unknown, ctx: StopHookContext): Promise<StopHalt | undefined> =>
  onTurnWillStop(payload as TurnWillStopPayload | undefined, ctx)

export default handler
