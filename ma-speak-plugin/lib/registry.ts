/**
 * In-process speech-job registry.
 *
 * The lifecycle here is the INVERSE of a normal tool: speech must OUTLIVE
 * the `Speak` tool call. The handler spawns a detached backend process,
 * registers it here, and returns a short handle (`s1`) immediately while the
 * audio keeps playing. Later `SpeakStatus` / `SpeakStop` calls — which are
 * separate tool invocations — look the job up by that handle.
 *
 * This works because minimal-agent imports a module handler ONCE (via
 * `await import(...)`) and reuses the resolved function for every call in the
 * session (see the agent's `loader/helpers.ts`). So a module-level singleton
 * created here is shared across all three handlers for the life of the agent
 * process. No disk, no IPC: the jobs live in this module's heap.
 *
 * State is a small discriminated union — `speaking | done | failed | stopped`
 * — so "is it still talking?" is a single tag check and illegal states (e.g.
 * "done with an exit code but still playing") are unrepresentable.
 *
 * The registry never spawns or signals a process itself. It stores a
 * {@link SpeechController} (pid + `stop()`) handed in by the backend layer,
 * keeping process mechanics out of the bookkeeping. Classic separation:
 * registry = state, backend = mechanism.
 *
 * @module lib/registry
 */

/** Lifecycle states of a speech job. Discriminated union, tag = the string. */
export type SpeechState = "speaking" | "done" | "failed" | "stopped"

/** A terminal state never transitions again. */
const TERMINAL: ReadonlySet<SpeechState> = new Set<SpeechState>(["done", "failed", "stopped"])

/** True if a state is terminal (no further transitions allowed). */
export function isTerminal(state: SpeechState): boolean {
  return TERMINAL.has(state)
}

/**
 * Process-control handle for one utterance, supplied by the backend layer.
 * The registry only ever reads `pid` and calls `stop()`; it knows nothing
 * about how the speech is actually produced.
 */
export interface SpeechController {
  /** OS process id of the spawned speech process (0 when unknown). */
  readonly pid: number
  /** Stop the speech now (terminate the process / its group). Idempotent;
   *  safe to call after the process already exited. */
  stop(): void
}

/** Internal record: the public job plus its (non-serialisable) controller. */
interface JobRecord {
  controller: SpeechController
  job: SpeechJob
}

/**
 * Public, read-only view of a speech job. This is what status/stop handlers
 * render and what tests assert against. No process handles leak out.
 */
export interface SpeechJob {
  /** Short model-facing handle, e.g. `s1`. Stable for the job's lifetime. */
  readonly id: string
  /** OS process id (0 when the backend could not report one). Shown for
   *  transparency; callers should prefer `id` to address a job. */
  readonly pid: number
  /** Backend id that produced the speech (e.g. `macos-say`). */
  readonly backend: string
  /** Length of the spoken text, in characters. */
  readonly charCount: number
  /** Short single-line preview of the spoken text (for the transcript). */
  readonly preview: string
  /** Current lifecycle state. */
  readonly state: SpeechState
  /** Epoch ms when the job started speaking. */
  readonly startedAt: number
  /** Epoch ms when the job reached a terminal state. Unset while speaking. */
  readonly endedAt?: number
  /** Backend exit code, when the job ended on its own (done/failed). */
  readonly exitCode?: number
  /** Short, backend-agnostic reason when `state === "failed"`. */
  readonly failureReason?: string
}

/** Options for {@link createRegistry}. All injectable for tests. */
export interface RegistryOptions {
  /** Clock. Defaults to `Date.now`. */
  now?: () => number
  /** Hard cap on retained jobs. Oldest terminal jobs are evicted past this.
   *  Prevents an unbounded heap in a very long session. Default 64. */
  maxJobs?: number
}

/** Single-line preview, clipped to `max` chars with an ellipsis. Pure. */
export function makePreview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

/**
 * The speech-job registry. One instance per agent process (see the module
 * singleton below), but constructable standalone for tests.
 */
export class SpeechRegistry {
  private readonly records = new Map<string, JobRecord>()
  private seq = 0
  private readonly now: () => number
  private readonly maxJobs: number

  constructor(opts: RegistryOptions = {}) {
    this.now = opts.now ?? Date.now
    this.maxJobs = opts.maxJobs ?? 64
  }

  /** Mint the next handle (`s1`, `s2`, …). Monotonic; never reused. */
  private nextId(): string {
    this.seq += 1
    return `s${this.seq}`
  }

  /**
   * Register a freshly-spawned utterance and return its public job view.
   * The job starts in `speaking`. The caller is responsible for wiring the
   * backend's exit to {@link markDone} / {@link markFailed}, and the stop
   * path to {@link stop}.
   */
  register(input: { controller: SpeechController; backend: string; text: string }): SpeechJob {
    this.evictIfNeeded()
    const id = this.nextId()
    const job: SpeechJob = {
      id,
      pid: input.controller.pid,
      backend: input.backend,
      charCount: input.text.length,
      preview: makePreview(input.text),
      state: "speaking",
      startedAt: this.now(),
    }
    this.records.set(id, { controller: input.controller, job })
    return job
  }

  /** Look up one job's public view by handle. `undefined` if unknown. */
  get(id: string): SpeechJob | undefined {
    return this.records.get(id)?.job
  }

  /** All jobs, oldest first. Returns public views only. */
  list(): SpeechJob[] {
    return [...this.records.values()].map((r) => r.job)
  }

  /** Jobs currently in the `speaking` state, oldest first. */
  active(): SpeechJob[] {
    return this.list().filter((j) => j.state === "speaking")
  }

  /**
   * Transition a job to a terminal state. Idempotent and monotonic: only a
   * `speaking` job moves; a call on an already-terminal job is ignored and
   * returns the existing job. Unknown id → `undefined`.
   */
  private settle(
    id: string,
    state: Exclude<SpeechState, "speaking">,
    extra: { exitCode?: number; failureReason?: string } = {},
  ): SpeechJob | undefined {
    const rec = this.records.get(id)
    if (!rec) return undefined
    if (rec.job.state !== "speaking") return rec.job
    const next: SpeechJob = {
      ...rec.job,
      state,
      endedAt: this.now(),
      ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(extra.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
    }
    rec.job = next
    return next
  }

  /** Mark a job finished normally (backend exited 0). */
  markDone(id: string, exitCode = 0): SpeechJob | undefined {
    return this.settle(id, "done", { exitCode })
  }

  /** Mark a job failed (backend exited non-zero or could not start). */
  markFailed(id: string, exitCode: number, failureReason: string): SpeechJob | undefined {
    return this.settle(id, "failed", { exitCode, failureReason })
  }

  /**
   * Mark a job `stopped`: it was interrupted by a signal (a `stop()` we issued,
   * or the parent-exit hook) rather than finishing or erroring on its own.
   * Monotonic, so a no-op if the job already settled.
   */
  markStopped(id: string, exitCode?: number): SpeechJob | undefined {
    return this.settle(id, "stopped", exitCode === undefined ? {} : { exitCode })
  }

  /**
   * Stop a job: signal its process via the stored controller, then mark it
   * `stopped`. Idempotent. Returns the (possibly already-terminal) job, or
   * `undefined` for an unknown id.
   *
   * When the job was already terminal we still return it (so the caller can
   * report "already finished") but do not signal again.
   */
  stop(id: string): SpeechJob | undefined {
    const rec = this.records.get(id)
    if (!rec) return undefined
    if (isTerminal(rec.job.state)) return rec.job
    try {
      rec.controller.stop()
    } catch {
      // Process already gone / not signalable. The state transition below
      // still reflects the user's intent.
    }
    return this.settle(id, "stopped")
  }

  /** Stop every currently-speaking job. Returns the jobs that were stopped. */
  stopAll(): SpeechJob[] {
    const stopped: SpeechJob[] = []
    for (const job of this.active()) {
      const s = this.stop(job.id)
      if (s && s.state === "stopped") stopped.push(s)
    }
    return stopped
  }

  /** Number of retained jobs (any state). */
  size(): number {
    return this.records.size
  }

  /**
   * Evict oldest TERMINAL jobs when over the cap. Never evicts a speaking
   * job (its controller must stay reachable for stop). Insertion order in a
   * Map is oldest-first, so we scan from the front.
   */
  private evictIfNeeded(): void {
    if (this.records.size < this.maxJobs) return
    for (const [id, rec] of this.records) {
      if (this.records.size < this.maxJobs) break
      if (isTerminal(rec.job.state)) this.records.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------

let singleton: SpeechRegistry | undefined

/**
 * The process-wide registry shared by all three handlers. Lazily created on
 * first use. Because the agent imports each handler module once and reuses it,
 * this single instance persists for the whole session.
 */
export function getRegistry(): SpeechRegistry {
  if (!singleton) singleton = new SpeechRegistry()
  return singleton
}

/** Test seam: drop the singleton so a test starts from a clean registry. */
export function resetRegistryForTests(): void {
  singleton = undefined
}
