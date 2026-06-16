/**
 * The reconcile tick: a PURE reducer at the heart of the plugin.
 *
 * `reconcile(input) -> { records, effects, changed }`. Given the current index
 * and, per active job, what the harness observed this pass (is the runner pid
 * alive? what does the status sidecar say?), it computes the next index AND a
 * list of {@link Effect} descriptions the shell executes (inject a completion
 * digest, emit a bus event).
 *
 * No IO, no clock, no bus. The heartbeat handler is the imperative shell that
 * gathers probes, calls this, runs the effects, and persists. This split makes
 * the lifecycle state machine exhaustively unit-testable. Mirrors the
 * sub-agents `supervisorTick`.
 *
 * @module lib/reconcile
 */

import { formatDuration } from "./duration.ts"
import type { Sidecar } from "./sidecar.ts"
import {
  pid as brandPid,
  isSuccess,
  isTerminal,
  type JobRecord,
  type JobStatus,
  type Pid,
} from "./types.ts"

/** What the shell observed about one job this tick. */
export interface JobProbe {
  /** Is the runner process still alive? */
  readonly runnerAlive: boolean
  /** The parsed status sidecar, when present + valid. */
  readonly sidecar?: Sidecar
}

/** A side-effect the shell must execute after the tick. Discriminated union. */
export type Effect =
  | { readonly type: "inject"; readonly text: string; readonly source: string }
  | { readonly type: "emit"; readonly channel: string; readonly payload: unknown }

/** Input to {@link reconcile}. */
export interface ReconcileInput {
  readonly records: readonly JobRecord[]
  /** Probe per job id (only active jobs need probing). */
  readonly probes: ReadonlyMap<string, JobProbe>
  /** ISO timestamp for status stamps. */
  readonly now: string
}

/** Output of {@link reconcile}. */
export interface ReconcileOutput {
  readonly records: JobRecord[]
  readonly effects: Effect[]
  /** True when any record changed (the shell should persist + repaint). */
  readonly changed: boolean
}

/** Map a sidecar's terminal phase to a {@link JobStatus}. Pure. */
function sidecarToStatus(s: Sidecar, now: string): JobStatus {
  const endedAt = s.endedAt ?? now
  switch (s.phase) {
    case "exited":
      return {
        kind: "exited",
        endedAt,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
        ...(s.signal !== undefined ? { signal: s.signal } : {}),
      }
    case "timedout":
      return { kind: "timedout", endedAt, timeoutMs: s.timeoutMs ?? 0 }
    case "stopped":
      return {
        kind: "stopped",
        endedAt,
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
      }
    case "running":
      // Should be filtered by the caller, treat as orphaned defensively.
      return { kind: "orphaned", endedAt, reason: "runner gone while sidecar said running" }
    default: {
      const _exhaustive: never = s.phase
      throw new Error(`unhandled sidecar phase: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Advance one record given its probe. Returns the next status (or the same
 * reference when unchanged) plus any effects the transition produced.
 */
function step(
  r: JobRecord,
  probe: JobProbe | undefined,
  now: string,
): { status: JobStatus; jobPid?: Pid; effects: Effect[] } {
  // Terminal records never change.
  if (isTerminal(r.status)) return { status: r.status, effects: [] }
  // No probe this tick (couldn't read): leave unchanged.
  if (!probe) return { status: r.status, effects: [] }

  const jobPid = probe.sidecar?.jobPid !== undefined ? brandPid(probe.sidecar.jobPid) : undefined

  // Runner still alive: maybe the sidecar already reports a terminal phase
  // (the runner writes the sidecar BEFORE exiting). Honor a terminal sidecar
  // even while the runner is briefly still alive, else just refresh jobPid.
  if (probe.runnerAlive) {
    if (probe.sidecar && probe.sidecar.phase !== "running") {
      const status = sidecarToStatus(probe.sidecar, now)
      return { status, ...(jobPid ? { jobPid } : {}), effects: terminalEffects(r, status) }
    }
    return { status: r.status, ...(jobPid ? { jobPid } : {}), effects: [] }
  }

  // Runner is gone. Trust a terminal sidecar if it wrote one, otherwise the
  // runner died without recording an outcome -> orphaned.
  if (probe.sidecar && probe.sidecar.phase !== "running") {
    const status = sidecarToStatus(probe.sidecar, now)
    return { status, ...(jobPid ? { jobPid } : {}), effects: terminalEffects(r, status) }
  }
  const status: JobStatus = {
    kind: "orphaned",
    endedAt: now,
    reason: "runner exited without recording an outcome (harness likely restarted)",
  }
  return { status, ...(jobPid ? { jobPid } : {}), effects: terminalEffects(r, status) }
}

/** A short, bounded digest line injected into the lead when a job finishes. */
export function completionDigest(r: JobRecord): string {
  const label = r.description
    ? `${r.id} (${r.description})`
    : `${r.id} (\`${clip(r.command, 60)}\`)`
  switch (r.status.kind) {
    case "exited": {
      const ok = isSuccess(r.status)
      const code =
        r.status.exitCode !== undefined
          ? `exit ${r.status.exitCode}`
          : r.status.signal
            ? `signal ${r.status.signal}`
            : "exited"
      return (
        `Background job ${label} finished: ${ok ? "succeeded" : "FAILED"} (${code}). ` +
        `Read it with BackgroundLogs ${r.id}.`
      )
    }
    case "timedout":
      return (
        `Background job ${label} timed out after ${formatDuration(r.status.timeoutMs)} and was killed. ` +
        `Read what it managed with BackgroundLogs ${r.id}.`
      )
    case "stopped":
      return `Background job ${label} was stopped${r.status.reason ? `: ${clip(r.status.reason, 80)}` : ""}.`
    case "orphaned":
      return `Background job ${label} is orphaned: ${clip(r.status.reason, 100)}. Its output up to that point is in BackgroundLogs ${r.id}.`
    case "running":
      return `Background job ${label} is running.`
    default: {
      const _exhaustive: never = r.status
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/** Effects emitted on any active-to-terminal transition: a bus signal + a digest. */
function terminalEffects(r: JobRecord, next: JobStatus): Effect[] {
  const withStatus: JobRecord = { ...r, status: next }
  return [
    { type: "emit", channel: "bgjob.didExit", payload: { id: r.id, status: next.kind } },
    { type: "inject", text: completionDigest(withStatus), source: `bgjob:${r.id}` },
  ]
}

/** Run one reconcile tick over the whole index. Pure. */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const out: JobRecord[] = []
  const effects: Effect[] = []
  let changed = false
  for (const r of input.records) {
    const probe = input.probes.get(r.id)
    const { status, jobPid, effects: fx } = step(r, probe, input.now)
    const nextJobPid = jobPid ?? r.jobPid
    if (status !== r.status || nextJobPid !== r.jobPid) {
      changed = true
      out.push({ ...r, status, ...(nextJobPid !== undefined ? { jobPid: nextJobPid } : {}) })
    } else {
      out.push(r)
    }
    for (const e of fx) effects.push(e)
  }
  return { records: out, effects, changed }
}
