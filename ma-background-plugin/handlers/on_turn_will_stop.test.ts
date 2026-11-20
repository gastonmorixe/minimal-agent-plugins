/**
 * Unit tests for the headless `turn.willStop` hook, with a fake reconcile
 * pass, a fake clock, a fake sleep and a fake signal source.
 */

import { EventEmitter } from "node:events"

import { afterEach, describe, expect, test } from "bun:test"

import {
  budgetDeadlineMs,
  DEFAULT_HEADLESS_WAIT_MS,
  HALT_COMPLETE,
  HALT_WAITED,
  haltReason,
  isHeadlessRun,
  MAX_HEADLESS_WAIT_MS,
  maxWaitMs,
  type Pass,
  stillRunningText,
  waitDeadlineMs,
} from "../lib/headless-wait.ts"
import { completionDigest, type Effect } from "../lib/reconcile.ts"
import { type JobRecord, type JobStatus, jobId, pid } from "../lib/types.ts"

import {
  onTurnWillStop,
  resetForTests,
  type StopHookContext,
  type StopHookSeams,
  unrefSleep,
} from "./on_turn_will_stop.ts"

const SID = "s-hook"
const T0 = Date.parse("2026-01-01T00:00:00Z")

afterEach(() => resetForTests())

function rec(id: string, status: JobStatus): JobRecord {
  return {
    id: jobId(id),
    command: "sleep 1; echo DONE-42",
    cwd: "/",
    runnerPid: pid(4242),
    timeoutMs: 600_000,
    spawnedAt: new Date(T0).toISOString(),
    status,
    logPath: `/tmp/${id}.log`,
    statusPath: `/tmp/${id}.status.json`,
  }
}

const RUNNING: JobStatus = {
  kind: "running",
  pid: pid(4243),
  startedAt: new Date(T0).toISOString(),
}
const EXITED0: JobStatus = { kind: "exited", endedAt: new Date(T0).toISOString(), exitCode: 0 }

function doneEffects(r: JobRecord): Effect[] {
  return [
    { type: "emit", channel: "bgjob.didExit", payload: { id: r.id, status: r.status.kind } },
    { type: "inject", text: completionDigest(r), source: `bgjob:${r.id}` },
  ]
}

/** A job that runs for `ticks` passes, then exits 0 (the digest comes on that pass once). */
function fakeJob(ticks: number): { reconcile: () => Pass; calls: () => number } {
  let n = 0
  return {
    reconcile: () => {
      n++
      if (n <= ticks) return { records: [rec("j1", RUNNING)], effects: [] }
      const done = rec("j1", EXITED0)
      return { records: [done], effects: n === ticks + 1 ? doneEffects(done) : [] }
    },
    calls: () => n,
  }
}

/** A fake clock: `sleep` moves the clock forward. */
function fakeClock(): Pick<StopHookSeams, "now" | "sleep"> & { slept: number[] } {
  let t = T0
  const slept: number[] = []
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
  }
}

/** A signal source with the `process` methods the hook uses. */
function fakeSignals(): NonNullable<StopHookSeams["signals"]> & EventEmitter & { kills: string[] } {
  const em = new EventEmitter() as EventEmitter & { kills: string[]; kill: unknown; pid: number }
  em.kills = []
  em.kill = (_pid: number, sig: string) => {
    em.kills.push(sig)
    return true
  }
  em.pid = 1
  return em as never
}

function ctx(over: Partial<StopHookContext> = {}): StopHookContext {
  return {
    packageDir: "/pkg",
    cwd: "/",
    env: {},
    abort: new AbortController().signal,
    agent: { sessionId: SID, pid: 1, model: "m", version: "0" },
    run: { mode: "one-shot", interactive: false },
    ...over,
  }
}

describe("isHeadlessRun", () => {
  test("the run fact decides when it is set", () => {
    expect(isHeadlessRun({ mode: "one-shot", interactive: false }, undefined, {})).toBe(true)
    expect(isHeadlessRun({ mode: "stream-json", interactive: false }, undefined, {})).toBe(true)
    expect(isHeadlessRun({ mode: "subagent", interactive: false }, undefined, {})).toBe(true)
    expect(isHeadlessRun({ mode: "repl", interactive: true }, { agentId: "A1" }, {})).toBe(false)
    expect(isHeadlessRun({ mode: "repl", interactive: false }, undefined, {})).toBe(false)
    expect(isHeadlessRun({ mode: "host", interactive: false }, undefined, {})).toBe(false)
  })

  test("with no run fact, a payload agentId or the wrap-up env decides", () => {
    expect(isHeadlessRun(undefined, { agentId: "A1" }, {})).toBe(true)
    expect(isHeadlessRun(undefined, {}, { MINIMAL_AGENT_WRAP_UP_TOOLS: "X" })).toBe(true)
    expect(isHeadlessRun(undefined, {}, { MINIMAL_AGENT_WRAP_UP_TOOLS: " " })).toBe(false)
    expect(isHeadlessRun(undefined, undefined, {})).toBe(false)
  })
})

describe("deadline", () => {
  test("max wait: default, env value, clamp, bad value", () => {
    expect(maxWaitMs({})).toBe(DEFAULT_HEADLESS_WAIT_MS)
    expect(maxWaitMs({ MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "5000" })).toBe(5000)
    expect(maxWaitMs({ MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "99999999" })).toBe(MAX_HEADLESS_WAIT_MS)
    expect(maxWaitMs({ MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "abc" })).toBe(DEFAULT_HEADLESS_WAIT_MS)
  })

  test("the budget deadline is the start + deadlineSec - 60 s", () => {
    const env = {
      MINIMAL_AGENT_SUBAGENT_BUDGET: JSON.stringify({ deadlineSec: 600 }),
      MINIMAL_AGENT_SUBAGENT_STARTED_AT: new Date(T0).toISOString(),
    }
    expect(budgetDeadlineMs(env)).toBe(T0 + 540_000)
    expect(waitDeadlineMs(env, T0)).toBe(T0 + 540_000)
    expect(budgetDeadlineMs({ MINIMAL_AGENT_SUBAGENT_BUDGET: "{bad" })).toBeUndefined()
    expect(waitDeadlineMs({}, T0)).toBe(T0 + DEFAULT_HEADLESS_WAIT_MS)
  })
})

describe("onTurnWillStop", () => {
  test("an interactive run is allowed with no reconcile pass", async () => {
    const job = fakeJob(3)
    const r = await onTurnWillStop({}, ctx({ run: { mode: "repl", interactive: true } }), {
      reconcile: job.reconcile,
    })
    expect(r).toBeUndefined()
    expect(job.calls()).toBe(0)
  })

  test("host mode is allowed", async () => {
    const job = fakeJob(3)
    const r = await onTurnWillStop({}, ctx({ run: { mode: "host", interactive: false } }), {
      reconcile: job.reconcile,
    })
    expect(r).toBeUndefined()
  })

  test("the opt-out env allows the stop", async () => {
    const envs: Record<string, string>[] = [
      { MINIMAL_AGENT_BG_HEADLESS_WAIT: "0" },
      { MINIMAL_AGENT_DISABLE_BGJOBS: "1" },
    ]
    for (const env of envs) {
      const job = fakeJob(3)
      expect(await onTurnWillStop({}, ctx({ env }), { reconcile: job.reconcile })).toBeUndefined()
      expect(job.calls()).toBe(0)
    }
  })

  test("headless with no jobs is allowed", async () => {
    const r = await onTurnWillStop({}, ctx(), { reconcile: () => ({ records: [], effects: [] }) })
    expect(r).toBeUndefined()
  })

  test("one running job that exits after 3 ticks gives a halt with its digest", async () => {
    const job = fakeJob(3)
    const clock = fakeClock()
    const signals = fakeSignals()
    const r = await onTurnWillStop({}, ctx(), { reconcile: job.reconcile, ...clock, signals })
    expect(r?.halt).toBe(true)
    expect(r?.reason).toContain("j1")
    expect(r?.reason).toContain("succeeded")
    expect(r?.reason).toContain("BackgroundLogs")
    expect(r?.reason.split("\n")[0]).toBe(HALT_WAITED)
    expect(job.calls()).toBe(4)
    expect(clock.slept).toEqual([1000, 1000, 1000])
    expect(signals.listenerCount("SIGTERM")).toBe(0)
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  test("a job that ended before the stop and was not reported gives a 'complete' halt", async () => {
    const done = rec("j1", EXITED0)
    const r = await onTurnWillStop({}, ctx(), {
      reconcile: () => ({ records: [done], effects: doneEffects(done) }),
      signals: fakeSignals(),
    })
    expect(r?.reason).toContain("succeeded")
    // No wait occurred: the first line says that the jobs are complete.
    expect(r?.reason.split("\n")[0]).toBe(HALT_COMPLETE)
  })

  test("the fallback detection works with no run fact (a worker payload)", async () => {
    const job = fakeJob(1)
    const r = await onTurnWillStop({ agentId: "A1" }, ctx({ run: undefined }), {
      reconcile: job.reconcile,
      ...fakeClock(),
      signals: fakeSignals(),
    })
    expect(r?.reason).toContain("j1")
  })

  test("deadline: one halt that says the job still runs, then allow on stopHookActive", async () => {
    const job = fakeJob(Number.POSITIVE_INFINITY)
    const env = { MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "3000" }
    const clock = fakeClock()
    const first = await onTurnWillStop({}, ctx({ env }), {
      reconcile: job.reconcile,
      ...clock,
      signals: fakeSignals(),
    })
    expect(first?.halt).toBe(true)
    expect(first?.reason).toBe(stillRunningText(["j1"], 3000))
    expect(first?.reason).toContain("Job j1 continues to run after")
    expect(first?.reason).toContain("When this turn stops, the job stops.")
    expect(first?.reason).toContain("BackgroundStop")
    const second = await onTurnWillStop({ stopHookActive: true }, ctx({ env }), {
      reconcile: job.reconcile,
      ...clock,
      signals: fakeSignals(),
    })
    expect(second).toBeUndefined()
  })

  test("the max wait is a total for the turn: a new job set does not get a new full wait", async () => {
    const env = { MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "3000" }
    const clock = fakeClock()
    let set = ["j1"]
    const reconcile = (): Pass => ({ records: set.map((id) => rec(id, RUNNING)), effects: [] })
    const first = await onTurnWillStop({}, ctx({ env }), {
      reconcile,
      ...clock,
      signals: fakeSignals(),
    })
    expect(first?.reason).toContain("Job j1 continues to run")
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(3000)
    // The model starts j2, then stops again: {j1, j2} is not the set of the last halt.
    set = ["j1", "j2"]
    const second = await onTurnWillStop({ stopHookActive: true }, ctx({ env }), {
      reconcile,
      ...clock,
      signals: fakeSignals(),
    })
    // No new wait: the total of the turn is used.
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(3000)
    expect(second?.reason).toBe(stillRunningText(["j1", "j2"], 3000))
    // The same set again: allow.
    const third = await onTurnWillStop({ stopHookActive: true }, ctx({ env }), {
      reconcile,
      ...clock,
      signals: fakeSignals(),
    })
    expect(third).toBeUndefined()
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(3000)
  })

  test("the wait total resets on a new turn and on an allow with no running job", async () => {
    const env = { MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "2000" }
    const clock = fakeClock()
    let records: JobRecord[] = [rec("j1", RUNNING)]
    const reconcile = (): Pass => ({ records, effects: [] })
    const seams = () => ({ reconcile, ...clock, signals: fakeSignals() })
    await onTurnWillStop({}, ctx({ env }), seams())
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(2000)
    // An allow with no running job resets the total.
    records = []
    expect(await onTurnWillStop({ stopHookActive: true }, ctx({ env }), seams())).toBeUndefined()
    records = [rec("j2", RUNNING)]
    await onTurnWillStop({ stopHookActive: true }, ctx({ env }), seams())
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(4000)
    // The first stop of a new turn (stopHookActive false) resets it too.
    await onTurnWillStop({}, ctx({ env }), seams())
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(6000)
  })

  test("an abort ends the wait at once and removes the listeners", async () => {
    const job = fakeJob(Number.POSITIVE_INFINITY)
    const ac = new AbortController()
    const signals = fakeSignals()
    const sleeps: AbortSignal[] = []
    // A sleep that never ends by itself: only the abort can end the wait.
    const sleep = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        sleeps.push(signal)
        signal.addEventListener("abort", () => resolve(), { once: true })
        ac.abort()
      })
    const r = await onTurnWillStop({}, ctx({ abort: ac.signal }), {
      reconcile: job.reconcile,
      sleep,
      signals,
    })
    expect(r).toBeUndefined()
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]?.aborted).toBe(true)
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) expect(signals.listenerCount(sig)).toBe(0)
  })

  test("SIGTERM ends the wait, and the listener has the fan-out tag", async () => {
    const job = fakeJob(Number.POSITIVE_INFINITY)
    const signals = fakeSignals()
    const owner = (): void => {}
    signals.on("SIGTERM", owner)
    const p = onTurnWillStop({}, ctx(), { reconcile: job.reconcile, signals })
    const ours = signals.listeners("SIGTERM").find((l) => l !== owner) as unknown as Record<
      symbol,
      unknown
    >
    expect(ours[Symbol.for("minimal-agent.signal-fanout")]).toBe(true)
    signals.emit("SIGTERM")
    expect(await p).toBeUndefined()
    // An owner listener exists, so the hook does not raise the signal again.
    expect(signals.kills).toEqual([])
    expect(signals.listeners("SIGTERM")).toEqual([owner])
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  test("SIGINT with no other listener raises the signal again", async () => {
    const job = fakeJob(Number.POSITIVE_INFINITY)
    const signals = fakeSignals()
    const p = onTurnWillStop({}, ctx(), { reconcile: job.reconcile, signals })
    signals.emit("SIGINT")
    expect(await p).toBeUndefined()
    expect(signals.kills).toEqual(["SIGINT"])
  })

  test("SIGHUP ends the wait too (the registry signal set)", async () => {
    const job = fakeJob(Number.POSITIVE_INFINITY)
    const signals = fakeSignals()
    const p = onTurnWillStop({}, ctx(), { reconcile: job.reconcile, signals })
    signals.emit("SIGHUP")
    expect(await p).toBeUndefined()
    expect(signals.kills).toEqual(["SIGHUP"])
  })

  test("another fan-out listener is not an owner: the hook raises the signal again", async () => {
    const job = fakeJob(Number.POSITIVE_INFINITY)
    const signals = fakeSignals()
    const other = Object.assign((): void => {}, {
      [Symbol.for("minimal-agent.signal-fanout")]: true,
    })
    signals.on("SIGTERM", other)
    const p = onTurnWillStop({}, ctx(), { reconcile: job.reconcile, signals })
    signals.emit("SIGTERM")
    expect(await p).toBeUndefined()
    expect(signals.kills).toEqual(["SIGTERM"])
  })
})

describe("unrefSleep", () => {
  test("an abort resolves it at once", async () => {
    const ac = new AbortController()
    let done = false
    const p = unrefSleep(60_000, ac.signal).then(() => {
      done = true
    })
    ac.abort()
    // One macrotask: the 60 s timer cannot fire, only the abort can resolve it.
    await new Promise((r) => setImmediate(r))
    expect(done).toBe(true)
    await p
  })

  test("an aborted signal resolves it with no timer", async () => {
    let done = false
    await unrefSleep(60_000, AbortSignal.abort()).then(() => {
      done = true
    })
    expect(done).toBe(true)
  })
})

describe("haltReason", () => {
  test("it clips after 10 digests", () => {
    const finished = new Map<string, string>()
    for (let i = 1; i <= 12; i++) finished.set(`j${i}`, `Background job j${i} finished.`)
    const text = haltReason({
      finished,
      running: [],
      deadlineHit: false,
      aborted: false,
      waitedMs: 0,
      waited: true,
    })
    expect(text).toContain("j10")
    expect(text).not.toContain("j11 finished")
    expect(text).toContain("And 2 more jobs are complete.")
  })

  test("the still-running text has a singular and a plural form", () => {
    expect(stillRunningText(["j1"], 1_200_000)).toBe(
      "Job j1 continues to run after 20m. When this turn stops, the job stops. " +
        "Stop it with BackgroundStop, or read its output with BackgroundLogs, then complete the task.",
    )
    expect(stillRunningText(["j1", "j2"], 1_200_000)).toBe(
      "Jobs j1, j2 continue to run after 20m. When this turn stops, the jobs stop. " +
        "Stop them with BackgroundStop, or read their output with BackgroundLogs, then complete the task.",
    )
  })
})
