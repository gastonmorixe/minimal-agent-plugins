/**
 * Service Layer: the orchestration the tool handlers and heartbeat share.
 *
 * `startJob` ties together the store (Repository), the config (limits), the
 * spawn shell (injected launcher), and the registry (live pipes) into one
 * application operation returning a {@link Result}. `runReconcile` drives one
 * supervisor pass. All collaborators are injected ({@link ServiceDeps}) so the
 * orchestration is unit-testable with a fake launcher and no real process.
 *
 * @module lib/service
 */

import type { BgConfig } from "./config.ts"
import { type Effect, type JobProbe, reconcile } from "./reconcile.ts"
import type { RunnerRegistry } from "./registry.ts"
import type { Sidecar } from "./sidecar.ts"
import { type LaunchFn, launchRunner } from "./spawn.ts"
import { BgJobStore, evictExcess } from "./store.ts"
import {
  pid as brandPid,
  err,
  isActive,
  type JobRecord,
  type JobStatus,
  ok,
  type Pid,
  type Result,
} from "./types.ts"

/** A validated, config-resolved request to start a job. */
export interface StartJobInput {
  readonly command: string
  readonly description?: string
  readonly cwd: string
  /** Already resolved to ms (the handler used config to parse the string). */
  readonly timeoutMs: number
}

/** Filesystem + path helpers the service needs (injected). */
export interface ServicePaths {
  /** Absolute path to `bin/runner.ts`. */
  readonly runnerPath: string
  /** How to invoke the runtime, e.g. `["bun", "run"]`. */
  readonly runtime: readonly string[]
  /** Per-job log path. */
  readonly logPath: (id: string) => string
  /** Per-job status sidecar path. */
  readonly statusPath: (id: string) => string
  /** Ensure the per-session job directory exists. */
  readonly ensureJobsDir: () => void
}

/** Everything the service needs, injected for testability. */
export interface ServiceDeps {
  readonly store: BgJobStore
  readonly registry: RunnerRegistry
  readonly config: BgConfig
  readonly paths: ServicePaths
  readonly launch: LaunchFn
  /** Base env the runner inherits. */
  readonly baseEnv: Record<string, string | undefined>
  readonly now: () => Date
}

/** Count active (running) jobs. */
function activeCount(records: readonly JobRecord[]): number {
  let n = 0
  for (const r of records) if (isActive(r.status)) n++
  return n
}

/**
 * Start one job. Enforces the concurrency cap, mints an id, launches the runner
 * (which opens the log + sidecar itself), tracks the live pipe in the registry,
 * and persists the index record. Returns the created record or a reason.
 */
export function startJob(input: StartJobInput, deps: ServiceDeps): Result<JobRecord> {
  const command = input.command.trim()
  if (command.length === 0) return err("command is required")

  const records = deps.store.all()
  const active = activeCount(records)
  if (active >= deps.config.limits.maxConcurrent) {
    return err(
      `too many background jobs running (${active}/${deps.config.limits.maxConcurrent}). ` +
        `Stop one with BackgroundStop, or wait for one to finish.`,
    )
  }

  const id = deps.store.nextId()
  const logPath = deps.paths.logPath(id)
  const statusPath = deps.paths.statusPath(id)
  deps.paths.ensureJobsDir()

  const launched = launchRunner(
    {
      runnerPath: deps.paths.runnerPath,
      runtime: deps.paths.runtime,
      jobId: id,
      command,
      cwd: input.cwd,
      logPath,
      statusPath,
      timeoutMs: input.timeoutMs,
      baseEnv: deps.baseEnv,
    },
    deps.launch,
  )
  if (!launched.ok) return err(launched.error)

  const handle = launched.value
  deps.registry.track(id, handle)

  const nowIso = deps.now().toISOString()
  const runnerPid: Pid = brandPid(handle.pid)
  const status: JobStatus = { kind: "running", pid: runnerPid, startedAt: nowIso }
  const record: JobRecord = {
    id,
    command,
    ...(input.description ? { description: input.description } : {}),
    cwd: input.cwd,
    runnerPid,
    timeoutMs: input.timeoutMs,
    spawnedAt: nowIso,
    status,
    logPath,
    statusPath,
  }

  // Persist with eviction of old terminal records (FIFO past maxTotal).
  const next = evictExcess([...records, record], deps.config.limits.maxTotal, (r) =>
    isActive(r.status),
  )
  deps.store.replaceAll(next)
  return ok(record)
}

// ---------------------------------------------------------------------------
// Reconcile (the heartbeat's pass)
// ---------------------------------------------------------------------------

/** IO the reconcile pass needs to probe runners + read sidecars. */
export interface ReconcileIO {
  /** True if a runner pid is still alive. */
  readonly runnerAlive: (pid: number) => boolean
  /** Read + parse a job's status sidecar, or `undefined`. */
  readonly readSidecar: (path: string) => Sidecar | undefined
}

/** What a reconcile pass produced (records persisted + effects to run). */
export interface ReconcileResult {
  readonly records: JobRecord[]
  readonly effects: Effect[]
  readonly changed: boolean
}

/**
 * Run one reconcile pass: probe each active job (runner liveness + sidecar),
 * run the pure reducer, persist if changed, and forget any job that became
 * terminal (closing its pipe in the registry). Returns the records + effects so
 * the heartbeat shell can run the effects (inject digests) and render.
 */
export function runReconcile(deps: ServiceDeps, io: ReconcileIO): ReconcileResult {
  const records = deps.store.all()

  const probes = new Map<string, JobProbe>()
  for (const r of records) {
    if (!isActive(r.status)) continue
    const sidecar = io.readSidecar(r.statusPath)
    probes.set(r.id, {
      runnerAlive: io.runnerAlive(r.runnerPid),
      ...(sidecar ? { sidecar } : {}),
    })
  }

  const out = reconcile({ records, probes, now: deps.now().toISOString() })
  if (out.changed) deps.store.replaceAll(out.records)

  // Forget any job that is now terminal: its pipe can be closed + dropped.
  for (const r of out.records) {
    if (!isActive(r.status) && deps.registry.get(r.id)) {
      deps.registry.forget(r.id)
    }
  }

  return { records: out.records, effects: out.effects, changed: out.changed }
}
