/**
 * Core domain types for the background-jobs plugin.
 *
 * Design posture mirrors minimal-agent's `sub-agents` plugin:
 *
 * - **Discriminated Union State** for {@link JobStatus}: a job's lifecycle is a
 *   tagged union so illegal states are unrepresentable (a `running` job carries
 *   a live pid, an `exited` one an exit code, a `stopped` one a reason). No
 *   status-string-plus-nullable-fields soup.
 * - **Branded types** for {@link JobId}, {@link Pid}, {@link SessionId} so a
 *   handle ("j2"), an OS pid, and a session uuid can never be swapped at a call
 *   site.
 * - **Result** for fallible operations, so failures are typed values, not
 *   thrown exceptions (no dependency, a tiny local helper).
 *
 * This module is PURE types + tiny constructors. No I/O, no process, no clock.
 *
 * @module lib/types
 */

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

/** A short, human-facing job handle the model uses, e.g. `"j2"`. */
export type JobId = string & { readonly __brand: "JobId" }

/** An OS process id. Branded so it can't be confused with a {@link JobId}. */
export type Pid = number & { readonly __brand: "Pid" }

/** A minimal-agent session id (uuid v4). */
export type SessionId = string & { readonly __brand: "SessionId" }

/** Brand a raw string as a {@link JobId} (no validation; ids are minted internally). */
export function jobId(s: string): JobId {
  return s as JobId
}

/** Brand a raw number as a {@link Pid}. */
export function pid(n: number): Pid {
  return n as Pid
}

/** Brand a raw string as a {@link SessionId}. */
export function sessionId(s: string): SessionId {
  return s as SessionId
}

// ---------------------------------------------------------------------------
// Result (typed failure, not exceptions)
// ---------------------------------------------------------------------------

/** A success/failure value. `E` defaults to `string` (a human-readable reason). */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }

/** Construct a success. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Construct a failure. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// Lifecycle status (discriminated union, illegal states unrepresentable)
// ---------------------------------------------------------------------------

/**
 * A background job's lifecycle state. Tagged by `kind`, each variant carries
 * exactly the data valid in that state.
 *
 * ```
 * running ──┬─▶ exited     (the job finished on its own, carries the exit code)
 *           ├─▶ timedout   (the deadline tripped, the runner killed it)
 *           ├─▶ stopped    (the model/user cancelled it)
 *           └─▶ orphaned   (its runner died with a previous harness, reconciled)
 * ```
 *
 * `exited` covers both success (`exitCode === 0`) and a job-level failure
 * (non-zero): the job RAN to completion, the exit code says how it went. A
 * crash of the job's own process surfaces as `exited` with a signal, never as a
 * separate "failed" kind. That keeps the union about lifecycle, not severity.
 */
export type JobStatus =
  | {
      readonly kind: "running"
      readonly pid: Pid
      readonly startedAt: string
    }
  | {
      readonly kind: "exited"
      readonly endedAt: string
      /** Process exit code (0 = success). `undefined` when only a signal is known. */
      readonly exitCode?: number
      /** Signal name when the job was killed by a signal (e.g. `"SIGSEGV"`). */
      readonly signal?: string
    }
  | {
      readonly kind: "timedout"
      readonly endedAt: string
      /** The deadline that tripped, in ms, for the message. */
      readonly timeoutMs: number
    }
  | {
      readonly kind: "stopped"
      readonly endedAt: string
      readonly reason?: string
    }
  | {
      readonly kind: "orphaned"
      readonly endedAt: string
      /** Why the job is orphaned (e.g. "runner pid not alive at reconcile"). */
      readonly reason: string
    }

/** All terminal status kinds (no further transitions). */
export type TerminalKind = "exited" | "timedout" | "stopped" | "orphaned"

/** True when a status is terminal (the job finished, one way or another). */
export function isTerminal(s: JobStatus): boolean {
  switch (s.kind) {
    case "exited":
    case "timedout":
    case "stopped":
    case "orphaned":
      return true
    case "running":
      return false
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** True when a job is still consuming resources (running). */
export function isActive(s: JobStatus): boolean {
  return !isTerminal(s)
}

/** True when an `exited` status represents a clean success (exit code 0). */
export function isSuccess(s: JobStatus): boolean {
  return s.kind === "exited" && s.exitCode === 0
}

// ---------------------------------------------------------------------------
// The durable handle (one record per job)
// ---------------------------------------------------------------------------

/**
 * A job handle, persisted append-style in `<sid>.bgjobs.jsonl`. This is the
 * harness-owned index record, the model addresses jobs by {@link JobRecord.id}.
 *
 * The runner owns the live detail (the `.log` bytes and a `.status.json`
 * sidecar), this record is the harness's reconciled view of it.
 */
export interface JobRecord {
  /** Short handle, e.g. `"j2"`. Unique within a session. */
  readonly id: JobId
  /** The shell command the job runs (`bash -c <command>`). */
  readonly command: string
  /** Short human label for the widget + log header. */
  readonly description?: string
  /** Working directory the job runs in. */
  readonly cwd: string
  /** Pid of the supervised runner process (its lifetime tracks the harness). */
  readonly runnerPid: Pid
  /** Pid of the actual job (the `bash -c` child), when the runner reported it. */
  readonly jobPid?: Pid
  /** Resolved timeout in ms. `0` means no deadline (operator-gated infinite). */
  readonly timeoutMs: number
  /** ISO timestamp the job was spawned. */
  readonly spawnedAt: string
  /** Current lifecycle state. */
  readonly status: JobStatus
  /** Absolute path to the durable raw log file. */
  readonly logPath: string
  /** Absolute path to the runner's status sidecar. */
  readonly statusPath: string
}

/** Per-status counts across a session's jobs. */
export interface JobStats {
  readonly total: number
  readonly running: number
  readonly exited: number
  readonly timedout: number
  readonly stopped: number
  readonly orphaned: number
  /** Of the `exited` jobs, how many succeeded (exit 0). */
  readonly succeeded: number
}

/** Compute {@link JobStats} over a set of records. Pure. */
export function jobStats(records: readonly JobRecord[]): JobStats {
  let running = 0
  let exited = 0
  let timedout = 0
  let stopped = 0
  let orphaned = 0
  let succeeded = 0
  for (const r of records) {
    switch (r.status.kind) {
      case "running":
        running++
        break
      case "exited":
        exited++
        if (r.status.exitCode === 0) succeeded++
        break
      case "timedout":
        timedout++
        break
      case "stopped":
        stopped++
        break
      case "orphaned":
        orphaned++
        break
      default: {
        const _exhaustive: never = r.status
        throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
      }
    }
  }
  return { total: records.length, running, exited, timedout, stopped, orphaned, succeeded }
}
