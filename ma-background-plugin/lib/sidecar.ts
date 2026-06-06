/**
 * The status sidecar: the small JSON document the RUNNER owns and rewrites as a
 * job transitions. The harness reads it (plus pid-liveness) to reconcile its
 * index without ever touching the runner's internals.
 *
 * Separation of ownership (no write races):
 *   - the harness owns `<sid>.bgjobs.jsonl` (the index of {@link JobRecord}s),
 *   - each runner owns its own `<jobId>.status.json` (this) + `<jobId>.log`.
 *
 * This module is PURE: the shape, a validating parser, and a serializer. No IO.
 *
 * @module lib/sidecar
 */

/** The phase a runner reports for its job. */
export type SidecarPhase = "running" | "exited" | "timedout" | "stopped"

/**
 * The runner-owned status document. Written atomically by the runner on each
 * transition. `phase` plus the optional fields below are everything the harness
 * needs to map a job to a terminal {@link JobStatus}.
 */
export interface Sidecar {
  /** Schema version, for forward compatibility. */
  readonly v: 1
  /** The job's short handle (echoed for cross-checking). */
  readonly id: string
  /** Pid of the actual `bash -c` job, when known. */
  readonly jobPid?: number
  /** Current phase. */
  readonly phase: SidecarPhase
  /** ISO timestamp the job started. */
  readonly startedAt: string
  /** ISO timestamp the job ended (terminal phases only). */
  readonly endedAt?: string
  /** Process exit code (phase `exited`). */
  readonly exitCode?: number
  /** Signal name if killed by a signal (phase `exited`/`stopped`). */
  readonly signal?: string
  /** The deadline that tripped, in ms (phase `timedout`). */
  readonly timeoutMs?: number
  /** Why it was stopped (phase `stopped`). */
  readonly reason?: string
  /** Bytes written to the log so far (best-effort progress hint). */
  readonly bytesLogged?: number
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

const PHASES: ReadonlySet<string> = new Set(["running", "exited", "timedout", "stopped"])

/**
 * Validate an untrusted parsed object as a {@link Sidecar}. Returns `undefined`
 * for anything malformed (so a half-written sidecar never crashes reconcile).
 */
export function parseSidecar(raw: unknown): Sidecar | undefined {
  if (!isObj(raw)) return undefined
  if (raw.v !== 1) return undefined
  if (typeof raw.id !== "string") return undefined
  if (typeof raw.phase !== "string" || !PHASES.has(raw.phase)) return undefined
  if (typeof raw.startedAt !== "string") return undefined

  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) ? x : undefined
  const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined)

  return {
    v: 1,
    id: raw.id,
    phase: raw.phase as SidecarPhase,
    startedAt: raw.startedAt,
    ...(num(raw.jobPid) !== undefined ? { jobPid: num(raw.jobPid) } : {}),
    ...(str(raw.endedAt) !== undefined ? { endedAt: str(raw.endedAt) } : {}),
    ...(num(raw.exitCode) !== undefined ? { exitCode: num(raw.exitCode) } : {}),
    ...(str(raw.signal) !== undefined ? { signal: str(raw.signal) } : {}),
    ...(num(raw.timeoutMs) !== undefined ? { timeoutMs: num(raw.timeoutMs) } : {}),
    ...(str(raw.reason) !== undefined ? { reason: str(raw.reason) } : {}),
    ...(num(raw.bytesLogged) !== undefined ? { bytesLogged: num(raw.bytesLogged) } : {}),
  }
}

/** Serialize a sidecar to compact JSON. Pure. */
export function serializeSidecar(s: Sidecar): string {
  return JSON.stringify(s)
}
