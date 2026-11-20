/**
 * The supervisor tick — a PURE reducer at the heart of the fleet.
 *
 * `supervisorTick(input) -> { records, effects, changed }`. Given the current
 * fleet, the probes the shell gathered this tick (is each worker's pid alive?
 * did it produce a result? how much progress?), and the wall clock, it
 * computes the next fleet AND a list of {@link Effect} DESCRIPTIONS the shell
 * executes (inject a digest, emit a bus event, kill a timed-out pid).
 *
 * No IO, no clock, no bus, no spawn. The heartbeat handler
 * (`handlers/heartbeat.ts`) is the imperative shell that gathers probes, calls this, runs
 * the effects, and persists the fleet. This split is what makes the lifecycle
 * state machine exhaustively unit-testable. Mirrors `schedule/lib/scheduler`.
 *
 * @module sub-agents/lib/supervisor
 */

import { fmtElapsed } from "./style.ts"
import {
  isTerminal,
  type Progress,
  type ResultDigest,
  type SubagentId,
  type SubagentRecord,
  type SubagentStatus,
} from "./types.ts"

/** What the shell observed about one worker this tick. */
export interface WorkerProbe {
  /** Is the worker's process still running? */
  readonly alive: boolean
  /** The worker's exit code, when it has exited. */
  readonly exitCode?: number
  /** A parsed result digest from the structured sentinel, when present. */
  readonly result?: ResultDigest
  /**
   * The worker's distilled FINAL assistant message, used ONLY as a fallback when
   * no structured `result` sentinel was written. Lower precedence than `result`.
   */
  readonly distilled?: string
  /** True when `distilled` was clipped at `SALVAGE_MAX_CHARS`. */
  readonly distilledClipped?: boolean
  /**
   * Of the worker's contracted `expectArtifacts`, the paths that are missing or
   * empty. Non-empty ⇒ the deliverable contract was not met (FIX 4).
   */
  readonly missingArtifacts?: readonly string[]
  /**
   * A crash signature mined from the worker's stdout/stderr log (FIX A): the
   * real cause of a startup/runtime death (bad model, missing beta, ENOENT, …).
   * Present ONLY when the worker exited producing no sentinel and no distillable
   * final message AND the log showed a fatal error. When set, the reducer reports
   * `failed` with this cause instead of laundering a crash into a generic
   * `incomplete · exited without a result`.
   */
  readonly crash?: string
  /** Live progress (tools/tokens/last activity), when the worker is running. */
  readonly progress?: Progress
  /** The worker's event stream reached `run_finished` / `result`. */
  readonly runEnded?: boolean
  /** Run wall time in ms, from the stream's final `result` line. */
  readonly durationMs?: number
  /**
   * The cause of a failed run as the worker's event stream reported it
   * (`error` + `run_finished: failed|aborted`). Structural, not mined, so it
   * outranks a distilled final message: a run that died mid-way is `failed`,
   * not `done` with half an answer. A result sentinel still wins.
   */
  readonly runFailed?: string
}

/** A side-effect the shell must execute after the tick. Discriminated union. */
export type Effect =
  | { readonly type: "inject"; readonly text: string; readonly source: string }
  | { readonly type: "emit"; readonly channel: string; readonly payload: unknown }
  | {
      readonly type: "stop"
      readonly id: SubagentId
      readonly pid: number
      readonly reason: string
    }
  | {
      /**
       * Ask the worker to stop politely (SIGTERM) at a limit. The worker then
       * runs one final turn that calls ReportResult. The reducer emits it ONCE
       * per worker: the `grace` marker on the running status latches it.
       */
      readonly type: "signal"
      readonly id: SubagentId
      readonly pid: number
      readonly sig: "SIGTERM"
      readonly reason: string
    }

/** Input to {@link supervisorTick}. */
export interface TickInput {
  readonly records: readonly SubagentRecord[]
  /** Probe per worker id (only active workers need probing). */
  readonly probes: ReadonlyMap<string, WorkerProbe>
  /** ISO timestamp for status stamps. */
  readonly now: string
  /** Epoch ms for budget math. */
  readonly nowMs: number
}

/** Output of {@link supervisorTick}. */
export interface TickOutput {
  readonly records: SubagentRecord[]
  readonly effects: Effect[]
  /** True when any record changed (the shell should persist + repaint). */
  readonly changed: boolean
}

/** A short, bounded digest line injected into the lead when a worker finishes. */
export function completionDigest(r: SubagentRecord): string {
  switch (r.status.kind) {
    case "done": {
      // The sentence below adds its own period, so drop a trailing one.
      const short = clip(r.status.result.short, 220).replace(/[.。]+$/, "")
      const facts = runFacts(r.status.result)
      return `Sub-agent ${r.id} (${r.label}) finished${facts}: ${short}. Pull the full result with SubAgentsAgentResult ${r.id}.`
    }
    case "incomplete": {
      const salvaged = r.status.salvage
        ? ` Its findings were salvaged (it produced a summary but not the required file). Read them with SubAgentsAgentResult ${r.id} before you decide. You may not need a full re-run.`
        : ` Inspect it with SubAgentsAgentResult ${r.id} and re-spawn if you still need the work.`
      return `Sub-agent ${r.id} (${r.label}) finished INCOMPLETE: deliverable contract not met (${clip(r.status.reason, 120)}). Not a clean success.${salvaged}`
    }
    case "failed": {
      // A grace failure can keep the final message (`salvage`). Say so, or the
      // lead re-spawns the same work and pays for it two times.
      const salvaged = r.status.salvage
        ? ` Its final message was salvaged (not verified). Read it with SubAgentsAgentResult ${r.id} before you re-spawn the work.`
        : ""
      return `Sub-agent ${r.id} (${r.label}) failed: ${clip(r.status.error, 160)}.${salvaged}`
    }
    case "stopped":
      return `Sub-agent ${r.id} (${r.label}) was stopped${r.status.reason ? `: ${clip(r.status.reason, 120)}` : ""}.`
    case "queued":
    case "running":
      return `Sub-agent ${r.id} (${r.label}) is ${r.status.kind}.`
    default: {
      throw new Error(`unhandled status kind: ${String(r.status satisfies never)}`)
    }
  }
}

/** ` (2m14 · 9 tools, 1 failed · 4 turns)`, or "" when nothing is known. */
function runFacts(c: {
  durationMs?: number
  tools: number
  toolErrors?: number
  turns?: number
}): string {
  const parts: string[] = []
  if (c.durationMs && c.durationMs >= 1000) parts.push(fmtElapsed(c.durationMs))
  if (c.tools > 0) parts.push(`${c.tools} tools${c.toolErrors ? `, ${c.toolErrors} failed` : ""}`)
  if (c.turns) parts.push(`${c.turns} turns`)
  return parts.length > 0 ? ` (${parts.join(" · ")})` : ""
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/**
 * Strip a leading `INCOMPLETE:` marker (and surrounding whitespace) from a
 * salvaged summary so the lead reads the findings, not the routing marker. The
 * status kind already carries the "incomplete" signal. Returns undefined when
 * nothing useful is left.
 */
function stripIncompleteMarker(short: string): string | undefined {
  const out = short.replace(/^\s*INCOMPLETE:\s*/, "").trim()
  return out.length > 0 ? out : undefined
}

/**
 * Hard wall-clock ceiling applied to EVERY running worker when its budget does
 * not set an explicit `deadlineSec` (B-083). Budgets are almost never set, so
 * without a default a worker that wedges mid-finalize (e.g. frozen at its
 * `ReportResult` write) stays `running` forever and permanently holds a
 * concurrency slot (it keeps counting toward `maxConcurrent` via `isActive`).
 * 30 min is generous enough that a legitimate long-running worker is not killed,
 * but a truly stuck one is eventually reaped. An explicit `budget.deadlineSec`
 * always overrides this.
 */
export const DEFAULT_DEADLINE_SEC = 30 * 60 // 30 minutes

/**
 * Grace period (seconds) between the SIGTERM at a limit and the SIGKILL. On
 * SIGTERM the worker stops its retry loop, runs ONE final turn that calls
 * ReportResult, and exits (it force-exits after 45 s or a second SIGTERM). 60 s
 * covers that with a margin. The SIGKILL stays as the fallback, because a
 * worker can swallow SIGTERM (see `handler-deps.ts`).
 */
export const DEFAULT_GRACE_SEC = 60

/**
 * Shorter no-progress window after which a worker would be treated as stalled.
 *
 * FOLLOW-UP (B-083, stall watchdog): a true stall watchdog needs a
 * last-progress timestamp on the record (e.g. `Progress.lastProgressAt` or a
 * `SubagentRecord` field the heartbeat stamps when tools/tokens advance). The
 * current `Progress` type ({@link types.ts}) carries `tools`/`tokens`/`lastTool`/
 * `lastActivity` but NO timestamp, and this reducer is pure (it only gets `now`
 * each tick), so it cannot measure "no progress for N seconds" without that
 * field. Rather than invent a whole tracking system here, the watchdog is left
 * as a follow-up: add a progress timestamp, then gate a stall kill on it through
 * the SAME terminal path as the deadline below. The default hard deadline
 * (above) already stops the unbounded slot leak in the meantime.
 */
export const DEFAULT_STALL_SEC = 5 * 60 // 5 minutes (reserved for the follow-up watchdog)

/**
 * The effective wall-clock deadline (seconds) for a worker: its explicit
 * `budget.deadlineSec` when set and positive, else the hard {@link
 * DEFAULT_DEADLINE_SEC} (B-083). A non-positive budget is treated as "unset".
 * Exported: the spawn path gives the same value to the worker (`ENV_BUDGET`).
 */
export function effectiveDeadlineSec(r: Pick<SubagentRecord, "budget">): number {
  const explicit = r.budget?.deadlineSec
  return explicit !== undefined && explicit > 0 ? explicit : DEFAULT_DEADLINE_SEC
}

/**
 * Deadline check: has a running worker blown its effective deadline? Unlike the
 * old check, an UNBUDGETED worker is no longer exempt — it falls back to
 * {@link DEFAULT_DEADLINE_SEC} so a wedged worker is eventually killed (B-083).
 */
function deadlineExceeded(r: SubagentRecord, startedAt: string, nowMs: number): boolean {
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return false
  return nowMs - startMs > effectiveDeadlineSec(r) * 1000
}

/**
 * The reason a running worker is past its turn or token budget, or
 * `undefined`. Both counts come from the worker's event stream:
 *
 *  - `maxTurns`: model responses (`turn_started.turn`). The worker gets
 *    `maxTurns` full turns and is stopped when turn `maxTurns + 1` starts.
 *  - `maxTokens`: generated tokens (output, thinking included) summed over all
 *    turns. That is the real spend. The context figure is not used, because it
 *    re-counts the same prefix every turn.
 *
 * A worker without stream telemetry (launched before streams) has no turn
 * count, so `maxTurns` cannot trip for it. A provider that reports no output
 * tokens cannot trip `maxTokens`.
 */
export function budgetExceeded(r: SubagentRecord, p: Progress): string | undefined {
  return budgetTrip(r, p)?.error
}

/** Which budget limit tripped, and its failure text. */
export interface BudgetTrip {
  readonly limit: "maxTurns" | "maxTokens"
  readonly error: string
}

/**
 * Like {@link budgetExceeded}, but also tells which limit tripped. `maxTokens`
 * is checked FIRST: it is a cost cap, and its trip gets no grace (see `step`).
 */
export function budgetTrip(r: SubagentRecord, p: Progress): BudgetTrip | undefined {
  const b = r.budget
  if (!b) return undefined
  if (b.maxTokens !== undefined && b.maxTokens > 0 && (p.output ?? 0) > b.maxTokens) {
    return {
      limit: "maxTokens",
      error: `budget exceeded: ${p.output} output tokens with maxTokens ${b.maxTokens}`,
    }
  }
  if (b.maxTurns !== undefined && b.maxTurns > 0 && (p.turns ?? 0) > b.maxTurns) {
    return {
      limit: "maxTurns",
      error: `budget exceeded: started turn ${p.turns} with maxTurns ${b.maxTurns}`,
    }
  }
  return undefined
}

/**
 * Advance one record given its probe. Returns the next status (or the same
 * reference when unchanged) plus any effects the transition produced.
 */
function step(
  r: SubagentRecord,
  probe: WorkerProbe | undefined,
  now: string,
  nowMs: number,
): { status: SubagentStatus; effects: Effect[] } {
  // Terminal states never change.
  if (isTerminal(r.status)) return { status: r.status, effects: [] }

  const s = r.status
  // queued: only the shell's spawn moves it to running (with a pid). If a
  // probe says the process is already gone before we ever saw it running,
  // treat it as a failed launch.
  if (s.kind === "queued") {
    if (probe && !probe.alive) {
      const status: SubagentStatus = {
        kind: "failed",
        endedAt: now,
        error: "worker exited before it started running",
        ...(probe.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
      }
      return { status, effects: terminalEffects(r, status, now) }
    }
    return { status: s, effects: [] }
  }

  // From here only `running` is possible (terminal states returned via the
  // `isTerminal` guard above; `queued` returned just now). This explicit check
  // also narrows `s` to the running variant for the type system.
  if (s.kind !== "running") return { status: s, effects: [] }

  // running: the interesting transitions.
  //
  // 1. SENTINEL WHILE ALIVE (Dorothy A1/A2): a structured result sentinel means
  //    the worker already handed work back via ReportResult. Finalize immediately
  //    (same done/incomplete rules as the exit path) and ask the shell to stop
  //    the lingering pid. This MUST run BEFORE the deadline check — otherwise a
  //    completed zombie is timed out as failed("No result") and the handoff is
  //    discarded. Distilled-only text is NOT enough while alive (mid-turn noise).
  if (probe?.result) {
    const { status, effects: termFx } = finalizeRunning(r, s, probe, now)
    const effects: Effect[] = []
    if (probe.alive) {
      effects.push({
        type: "stop",
        id: r.id,
        pid: s.pid,
        reason: "result sentinel written",
      })
    }
    effects.push(...termFx)
    return { status, effects }
  }

  // 1a. GRACE PHASE: the worker got SIGTERM at a limit (step 1c or 2) and has
  //     time to report. Step 1 above already finishes it when its sentinel
  //     appears. The limits are NOT checked again, so the SIGTERM goes out only
  //     once per worker.
  if (s.grace) return stepGrace(r, s, s.grace, probe, now, nowMs)

  // 1b. RUN ENDED WHILE ALIVE: the worker's event stream wrote its final line
  //     (`result`, or a failed `run_finished`), so the run is over and only the
  //     process lingers (an open child such as obscura-worker, a slow flush).
  //     Finalize now and stop the pid, instead of holding a concurrency slot
  //     until the deadline. Same rules as the exit path.
  if (probe?.alive && probe.runEnded) {
    const { status, effects: termFx } = finalizeRunning(r, s, probe, now)
    return {
      status,
      effects: [{ type: "stop", id: r.id, pid: s.pid, reason: "run finished" }, ...termFx],
    }
  }

  // 1c. TURN / TOKEN BUDGET: stream telemetry gives live counts. Checked after
  //     the sentinel and run-ended paths, so a worker that already handed its
  //     work back is never stopped for its budget.
  //   - maxTurns: the SAME grace as the deadline (SIGTERM first, SIGKILL after
  //     DEFAULT_GRACE_SEC). The work done so far has value, and the wrap-up
  //     adds ONE turn only (the worker can call ReportResult and nothing else).
  //   - maxTokens: NO grace. SIGKILL and `failed` at once (the old hard path).
  //     The trip is usually in the middle of a response, and the wrap-up turn
  //     uses the full model `max_tokens` (and a retry). One wrap-up response
  //     can be much larger than the whole budget, so a grace breaks the cap.
  const trip = budgetTrip(r, probe?.progress ?? s.progress)
  if (trip?.limit === "maxTokens") return hardBudgetStop(r, s, probe, trip.error, now)
  if (trip) return startGrace(r, s, probe, trip.error, "budget", now, nowMs)

  // 2. Deadline tripped → SIGTERM and a grace period (step 1a), then SIGKILL
  //    and failed(timeout). This fires for UNBUDGETED workers too, via the
  //    DEFAULT_DEADLINE_SEC fallback in `deadlineExceeded` (B-083): a worker
  //    wedged mid-finalize (e.g. stuck at ReportResult) used to be exempt and
  //    leaked its concurrency slot forever. The grace end goes through the SAME
  //    stop + terminalEffects path as before (no B-087-style bypass).
  //    Only reached when there is NO sentinel — step 1 already salvaged that case.
  if (deadlineExceeded(r, s.startedAt, nowMs)) {
    const hadBudget = (r.budget?.deadlineSec ?? 0) > 0
    const error = hadBudget
      ? "timed out (budget deadline exceeded)"
      : `timed out (no progress, exceeded ${DEFAULT_DEADLINE_SEC}s default hard deadline, likely wedged)`
    return startGrace(r, s, probe, error, "deadline", now, nowMs)
  }
  // 3. No probe this tick → leave unchanged (transient: shell couldn't read).
  if (!probe) return { status: s, effects: [] }
  // 4. Still alive, no sentinel → refresh progress (no terminal effects).
  if (probe.alive) {
    if (!probe.progress) return { status: s, effects: [] }
    return { status: { ...s, progress: probe.progress }, effects: [] }
  }
  // 5. Exited (no sentinel already handled above). Decide the terminal status.
  return finalizeRunning(r, s, probe, now)
}

type Running = Extract<SubagentStatus, { kind: "running" }>
type Grace = NonNullable<Running["grace"]>
type StepResult = { status: SubagentStatus; effects: Effect[] }

// No special case for exit 143 (the exit after our SIGTERM): production has no
// exit code (the spawn is fire-and-forget, `realProbeDeps` has no `exitCode`),
// so such a branch never runs. A sentinel always finishes the worker in step 1.

/**
 * The `failed` status of a limit (deadline, maxTurns, maxTokens) and its
 * terminal effects. The ONE place that builds it, for the grace end, a run
 * end in the grace, and the hard maxTokens stop. `probe` (when known) adds
 * the exit code, a crash text, and the distilled final message as `salvage`.
 */
function limitFailed(
  r: SubagentRecord,
  error: string,
  probe: WorkerProbe | undefined,
  now: string,
): StepResult {
  const salvage = probe?.distilled?.trim()
  // A crash text (log signature) after the limit stays visible. An exit code
  // of 0 is a clean end, so a crash text then is not the cause.
  const crash = probe?.crash && probe.exitCode !== 0 ? `; then ${probe.crash}` : ""
  const status: SubagentStatus = {
    kind: "failed",
    endedAt: now,
    error: `${error}${crash}`,
    ...(probe?.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
    ...(salvage ? { salvage } : {}),
    ...(salvage && probe?.distilledClipped ? { salvageClipped: true } : {}),
  }
  return { status, effects: terminalEffects(r, status, now) }
}

/** `limitFailed`, plus a `stop` (SIGKILL) effect first when the pid can be alive. */
function limitFailedAndStop(
  r: SubagentRecord,
  s: Running,
  error: string,
  probe: WorkerProbe | undefined,
  reason: string,
  now: string,
): StepResult {
  const { status, effects } = limitFailed(r, error, probe, now)
  if (probe && !probe.alive) return { status, effects }
  return { status, effects: [{ type: "stop", id: r.id, pid: s.pid, reason }, ...effects] }
}

/**
 * The maxTokens trip: SIGKILL and `failed` at once, with no grace (see step
 * 1c). The distilled text is not read while the worker is alive, so there is
 * no salvage here.
 */
function hardBudgetStop(
  r: SubagentRecord,
  s: Running,
  probe: WorkerProbe | undefined,
  error: string,
  now: string,
): StepResult {
  return limitFailedAndStop(r, s, error, probe, "budget", now)
}

/**
 * Enter the grace phase: one SIGTERM effect, and the worker stays `running`
 * with a `grace` marker. No terminal effects yet. A worker that is already
 * gone skips the grace and fails at once with `error`.
 */
function startGrace(
  r: SubagentRecord,
  s: Running,
  probe: WorkerProbe | undefined,
  error: string,
  reason: string,
  now: string,
  nowMs: number,
): StepResult {
  if (probe && !probe.alive) return limitFailed(r, error, probe, now)
  const until = new Date(nowMs + DEFAULT_GRACE_SEC * 1000).toISOString()
  const progress = probe?.progress ?? s.progress
  return {
    status: { ...s, progress, grace: { until, error } },
    effects: [{ type: "signal", id: r.id, pid: s.pid, sig: "SIGTERM", reason }],
  }
}

/**
 * One tick in the grace phase. The sentinel path ran before this, so here
 * there is NO sentinel.
 *  - The run ended (also cleanly, for example outcome `truncated` after the
 *    wrap-up turn), or the process exited: `failed` with the limit text, so
 *    the lead sees that the limit caused it. The distilled final message
 *    stays on the status as `salvage`. Stop a lingering pid.
 *  - The grace ended: SIGKILL (the `stop` effect) and `failed` with the limit text.
 */
function stepGrace(
  r: SubagentRecord,
  s: Running,
  grace: Grace,
  probe: WorkerProbe | undefined,
  now: string,
  nowMs: number,
): StepResult {
  if (probe && (!probe.alive || probe.runEnded)) {
    return limitFailedAndStop(r, s, grace.error, probe, "grace: run ended", now)
  }
  const untilMs = Date.parse(grace.until)
  if (!Number.isFinite(untilMs) || nowMs >= untilMs) {
    // The probe of an alive worker has no distilled text, so no salvage here.
    return limitFailedAndStop(r, s, grace.error, undefined, "grace ended", now)
  }
  if (!probe?.progress) return { status: s, effects: [] }
  return { status: { ...s, progress: probe.progress }, effects: [] }
}

/**
 * Decide the terminal status for a running worker given its probe. Shared by the
 * exit path and the "sentinel while alive" path so contract / incomplete / done /
 * crash rules stay in one place. Caller is responsible for emitting a `stop`
 * effect when the pid is still alive.
 */
function finalizeRunning(
  r: SubagentRecord,
  running: Extract<SubagentStatus, { kind: "running" }>,
  probe: WorkerProbe,
  now: string,
): { status: SubagentStatus; effects: Effect[] } {
  // The final probe's progress is the newest. A fast worker can finish before
  // any tick stored progress on `running`, so fall back only when it is absent.
  const s = probe.progress ? { ...running, progress: probe.progress } : running
  // a. A non-zero exit → failed (it crashed), regardless of any artifacts.
  //    Prefer the log's crash signature (the REAL cause: bad model, missing
  //    beta, ENOENT) over the bare exit code, so the lead reads "why" not
  //    just "code 1".
  if (probe.exitCode !== undefined && probe.exitCode !== 0) {
    const error = probe.crash
      ? `${probe.crash} (exit ${probe.exitCode})`
      : `exited with code ${probe.exitCode}`
    const status: SubagentStatus = {
      kind: "failed",
      endedAt: now,
      error,
      exitCode: probe.exitCode,
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // a0. The worker's own event stream says the run failed and it handed back
  //     no sentinel → failed with the reported cause (API error, bad model,
  //     abort). Checked before the distilled-text path on purpose.
  if (probe.runFailed && !probe.result) {
    const status: SubagentStatus = {
      kind: "failed",
      endedAt: now,
      error: probe.runFailed,
      ...(probe.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // a'. FIX A: the exit code is UNKNOWABLE in production (Bun.spawn is
  //     detached; the supervisor only has pid-liveness, not a wait status).
  //     So a boot crash arrives here with exitCode `undefined` but a crash
  //     signature in the log. Treat a found signature as a failure with the
  //     real cause — this is the fix for the "incomplete · exited without a
  //     result" mislabel that hid the `long context beta` 400 behind a
  //     generic message. Only fires when the worker produced nothing usable
  //     (the probe only reads the log in that case).
  if (probe.crash && !probe.result && !(probe.distilled && probe.distilled.trim().length > 0)) {
    const status: SubagentStatus = { kind: "failed", endedAt: now, error: probe.crash }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // b. CONTRACT CHECK (FIX 4): the worker declared `expectArtifacts` and some
  //    are missing/empty → INCOMPLETE, even if it wrote a sentinel or a final
  //    message. A claimed-but-absent deliverable is the strongest failure
  //    signal; never launder it into done.
  //
  //    FIX 5 (the A2/A3 data-loss bug): the contract miss is a HARD gate, but
  //    it must NOT throw away the synthesis the worker actually produced. If
  //    the worker wrote a result sentinel (or left a distillable final
  //    message), SALVAGE that text onto the `incomplete` status so the lead
  //    reads the findings via AgentResult instead of being forced to mine the
  //    worker's raw transcript. Sentinel text wins over distilled (same
  //    precedence as the done path). We still report `incomplete` and still
  //    cancel any linked todo — the deliverable genuinely wasn't met.
  const missing = probe.missingArtifacts
  if (missing && missing.length > 0) {
    const total = r.expectArtifacts?.length ?? missing.length
    const salvage = (probe.result?.short ?? probe.distilled)?.trim() || undefined
    const claimed = probe.result?.artifacts
    const status: SubagentStatus = {
      kind: "incomplete",
      endedAt: now,
      reason: `missing ${missing.length}/${total} required artifact(s): ${missing.join(", ")}`,
      ...spendOf(s.progress),
      ...(salvage ? { salvage } : {}),
      ...(claimed && claimed.length > 0 ? { artifacts: claimed } : {}),
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // c0. The worker SELF-REPORTED incompletion (ReportResult({incomplete:true})
  //     or a hand-written `INCOMPLETE:` sentinel). Honor it: route to
  //     `incomplete`, never launder an honest "I could not finish" into
  //     `done`. We still salvage the worker's summary (minus the marker
  //     prefix) so the lead reads the findings, and surface any claimed
  //     artifacts. A linked todo is canceled, not ticked green.
  if (probe.result?.incomplete) {
    const salvage = stripIncompleteMarker(probe.result.short)
    const claimed = probe.result.artifacts
    const status: SubagentStatus = {
      kind: "incomplete",
      endedAt: now,
      reason: "worker reported it could not finish",
      ...spendOf(s.progress),
      ...(salvage ? { salvage } : {}),
      ...(claimed && claimed.length > 0 ? { artifacts: claimed } : {}),
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // c. A parsed result sentinel → done. (FIX 3: when the sentinel's OWN
  //    declared `artifacts[]` are missing on disk, the shell probe has already
  //    prepended a "⚠ N/M artifacts missing" warning to `result.short`, so the
  //    lead is told without the reducer needing filesystem access.)
  if (probe.result) {
    const status: SubagentStatus = {
      kind: "done",
      endedAt: now,
      result: { ...withObservedCounts(probe.result, s.progress), ...durationOf(probe) },
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // d. Clean exit, no sentinel, BUT a distillable final message → done. The
  //    worker said something useful as its last turn; surface it rather than
  //    lose it. Marked `distilled` so the lead can tell it apart from a real
  //    structured sentinel. (Exit-path only — alive workers never reach here
  //    without a sentinel, because step() returns early for alive+no-result.)
  if (probe.distilled && probe.distilled.trim().length > 0) {
    const status: SubagentStatus = {
      kind: "done",
      endedAt: now,
      result: {
        short: probe.distilled.trim(),
        ...spendOf(s.progress),
        ...durationOf(probe),
        distilled: true,
      },
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  // e. Clean exit but NO deliverable AND no final text → INCOMPLETE. The
  //    critical fix: a missing deliverable is NOT laundered into `done`.
  const status: SubagentStatus = {
    kind: "incomplete",
    endedAt: now,
    reason: "exited without a result sentinel or any final message",
    ...spendOf(s.progress),
  }
  return { status, effects: terminalEffects(r, status, now) }
}

/**
 * Counts for a sentinel result. ReportResult writes 0 when the model passes
 * no counts, so a zero there means "not reported". The transcript progress
 * is measured, so it wins unless the worker reported a larger value.
 */
function withObservedCounts(result: ResultDigest, progress: Progress): ResultDigest {
  const tokens = Math.max(result.tokens, progress.tokens)
  const tools = Math.max(result.tools, progress.tools)
  // The worker never reports output, thinking, turns or tool errors, so these
  // come from progress.
  return { ...result, tokens, tools, ...outputOf(progress), ...streamCountsOf(progress) }
}

/** Turn and tool-error counts of a progress value (absent stays absent). */
function streamCountsOf(p: Progress): Pick<Progress, "turns" | "toolErrors"> {
  return {
    ...(p.turns ? { turns: p.turns } : {}),
    ...(p.toolErrors ? { toolErrors: p.toolErrors } : {}),
  }
}

/** The run wall time a probe carries, as a result field. */
function durationOf(probe: WorkerProbe): { durationMs?: number } {
  return probe.durationMs ? { durationMs: probe.durationMs } : {}
}

/** The summed output and thinking of a progress value (absent stays absent). */
function outputOf(p: Progress): Pick<Progress, "output" | "thinking"> {
  return {
    ...(p.output !== undefined ? { output: p.output } : {}),
    ...(p.thinking !== undefined ? { thinking: p.thinking } : {}),
  }
}

/** Every count a terminal status copies from progress. */
function spendOf(
  p: Progress,
): Pick<Progress, "tokens" | "tools" | "output" | "thinking" | "turns" | "toolErrors"> {
  return { tokens: p.tokens, tools: p.tools, ...outputOf(p), ...streamCountsOf(p) }
}

/** Added to the cancel reason of a linked task when a failed worker has a salvage. */
export const SALVAGED_TASK_NOTE = " (final message salvaged; read it with SubAgentsAgentResult)"

/** Effects emitted on any active→terminal transition: a bus signal + a lead digest. */
function terminalEffects(r: SubagentRecord, next: SubagentStatus, _now: string): Effect[] {
  const withStatus: SubagentRecord = { ...r, status: next }
  const effects: Effect[] = [
    {
      type: "emit",
      channel: "subagent.didReport",
      payload: { id: r.id, sid: r.sid, status: next.kind },
    },
    {
      type: "emit",
      channel: "subagent.didExit",
      payload: { id: r.id, sid: r.sid, status: next.kind },
    },
  ]
  let linkedTaskNotice = ""
  // Tasks-plugin linkage (decoupled, via the bus): if this worker owns a todo,
  // tick it green on a clean finish, or cancel it (with a reason) otherwise.
  // Emit the mutation BEFORE the model-facing digest so the tasks subscriber
  // persists the new state before the lead is told to act on the completion.
  if (r.taskId) {
    // Only a real `done` ticks the linked todo green. `incomplete` (no
    // deliverable) is a FAILURE signal, so it cancels the todo with the reason
    // rather than laundering it into success.
    const status = next.kind === "done" ? "done" : "canceled"
    const reason =
      next.kind === "failed"
        ? `${next.error}${next.salvage ? SALVAGED_TASK_NOTE : ""}`
        : next.kind === "incomplete"
          ? `no deliverable: ${next.reason}`
          : next.kind === "stopped"
            ? next.reason
            : undefined
    effects.push({
      type: "emit",
      channel: "subagent.taskUpdate",
      payload: { taskId: r.taskId, status, ...(reason ? { reason } : {}), bySubagent: r.id },
    })
    linkedTaskNotice =
      status === "done"
        ? ` Linked task ${r.taskId} was automatically marked done; do not call Task.done for it.`
        : ` Linked task ${r.taskId} was automatically canceled; do not mark it done.`
  }
  effects.push({
    type: "inject",
    text: `${completionDigest(withStatus)}${linkedTaskNotice}`,
    source: `subagent:${r.id}`,
  })
  return effects
}

/**
 * Run one supervisor tick over the whole fleet. Pure.
 */
export function supervisorTick(input: TickInput): TickOutput {
  const out: SubagentRecord[] = []
  const effects: Effect[] = []
  let changed = false
  for (const r of input.records) {
    const probe = input.probes.get(r.id)
    const { status, effects: fx } = step(r, probe, input.now, input.nowMs)
    if (status !== r.status) {
      changed = true
      const lastPid = r.status.kind === "running" ? r.status.pid : r.lastPid
      out.push({ ...r, status, ...(lastPid !== undefined ? { lastPid } : {}) })
    } else {
      out.push(r)
    }
    for (const e of fx) effects.push(e)
  }
  return { records: out, effects, changed }
}
