/**
 * In-process registry of LIVE runner handles.
 *
 * Each background job has a detached runner whose stdin write-end the harness
 * must KEEP OPEN for the job's lifetime (that open pipe is the harness-liveness
 * link the runner watches). This registry is where those handles live. Because
 * minimal-agent imports a handler module ONCE per session and reuses it, a
 * module-level singleton here is shared across all handlers for the life of the
 * harness process. No disk, no IPC: the handles live in this module's heap.
 *
 * Two jobs the registry owns:
 *   1. hold each {@link RunnerHandle} so its pipe stays open until the job ends
 *      or the model stops it,
 *   2. install ONE shared parent-exit fan-out (over `process.on(exit|SIGINT|
 *      SIGTERM|SIGHUP)`) that closes every pipe when the harness exits
 *      GRACEFULLY. That is the fast path, the runner's own stdin-EOF detection
 *      is the foolproof layer that also covers a harness SIGKILL.
 *
 * The registry never spawns a process, the spawn shell hands it a handle. It
 * also tracks the runner pid so a stop can group-kill even after the pipe has
 * been closed.
 *
 * @module lib/registry
 */

import type { RunnerHandle } from "./spawn.ts"

/** A live runner the harness is supervising. */
interface LiveRunner {
  readonly jobId: string
  readonly handle: RunnerHandle
}

/** Injectable process hooks, so the registry is testable without real signals. */
export interface RegistryDeps {
  /** Subscribe a callback to harness-exit events. Returns an unsubscribe. */
  readonly onParentExit: (cb: () => void) => () => void
  /** Group-kill a runner (and its job) by runner pid + signal. */
  readonly killRunner: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * The live-runner registry. One instance per harness process (the module
 * singleton below), constructable standalone for tests.
 */
export class RunnerRegistry {
  private readonly runners = new Map<string, LiveRunner>()
  private unsubscribeParentExit: (() => void) | null = null

  constructor(private readonly deps: RegistryDeps) {}

  /**
   * Track a freshly-launched runner. Installs the shared parent-exit fan-out on
   * the first track (so a graceful harness exit closes the pipe). Idempotent per
   * job id: a re-track replaces the prior handle.
   */
  track(jobId: string, handle: RunnerHandle): void {
    this.ensureParentExitHook()
    this.runners.set(jobId, { jobId, handle })
  }

  /** The live handle for a job, or `undefined`. */
  get(jobId: string): RunnerHandle | undefined {
    return this.runners.get(jobId)?.handle
  }

  /** Job ids currently tracked. */
  ids(): string[] {
    return [...this.runners.keys()]
  }

  /** Number of tracked runners. */
  size(): number {
    return this.runners.size
  }

  /**
   * Stop a job: group-kill its runner (which tears down the job) and close the
   * pipe, then forget it. Idempotent. Returns true if the job was tracked.
   */
  stop(jobId: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const live = this.runners.get(jobId)
    if (!live) return false
    try {
      this.deps.killRunner(live.handle.pid, signal)
    } catch {
      // already gone
    }
    try {
      live.handle.closeStdin()
    } catch {
      // pipe already closed
    }
    this.runners.delete(jobId)
    this.teardownIfEmpty()
    return true
  }

  /**
   * Forget a job that finished on its own (the reconcile pass saw it terminal).
   * Closes its pipe (harmless if the runner already exited) and drops it.
   */
  forget(jobId: string): void {
    const live = this.runners.get(jobId)
    if (!live) return
    try {
      live.handle.closeStdin()
    } catch {
      // already closed
    }
    this.runners.delete(jobId)
    this.teardownIfEmpty()
  }

  /** Stop every tracked job. Returns the ids stopped. */
  stopAll(signal: NodeJS.Signals = "SIGTERM"): string[] {
    const ids = this.ids()
    for (const id of ids) this.stop(id, signal)
    return ids
  }

  /** Install the shared parent-exit fan-out once. */
  private ensureParentExitHook(): void {
    if (this.unsubscribeParentExit) return
    this.unsubscribeParentExit = this.deps.onParentExit(() => {
      // Graceful harness exit: close every pipe so each runner sees EOF and
      // tears its job down promptly (rather than waiting on its own poll).
      for (const live of this.runners.values()) {
        try {
          live.handle.closeStdin()
        } catch {
          // ignore
        }
      }
    })
  }

  /** Drop the parent-exit hook when no runners remain (keeps listeners flat). */
  private teardownIfEmpty(): void {
    if (this.runners.size === 0 && this.unsubscribeParentExit) {
      this.unsubscribeParentExit()
      this.unsubscribeParentExit = null
    }
  }
}

// ---------------------------------------------------------------------------
// Shared parent-exit fan-out (flat listener count, like ma-speak)
// ---------------------------------------------------------------------------

const PARENT_EXIT_EVENTS = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const
const parentExitCallbacks = new Set<() => void>()
let parentExitDispatch: (() => void) | null = null

function installParentExitDispatch(): void {
  if (parentExitDispatch) return
  const dispatch = () => {
    for (const cb of [...parentExitCallbacks]) {
      try {
        cb()
      } catch {
        // never let cleanup throw during shutdown
      }
    }
  }
  parentExitDispatch = dispatch
  for (const ev of PARENT_EXIT_EVENTS) process.on(ev, dispatch)
}

function removeParentExitDispatch(): void {
  if (!parentExitDispatch) return
  for (const ev of PARENT_EXIT_EVENTS) process.off(ev, parentExitDispatch)
  parentExitDispatch = null
}

/**
 * Default parent-exit hook: one shared per-event listener fans out to a callback
 * set, so N tracked runners never stack N copies of a signal handler. Returns an
 * unsubscribe that drops just this callback (and removes the shared listeners
 * once the set is empty).
 */
export function defaultOnParentExit(cb: () => void): () => void {
  parentExitCallbacks.add(cb)
  installParentExitDispatch()
  return () => {
    parentExitCallbacks.delete(cb)
    if (parentExitCallbacks.size === 0) removeParentExitDispatch()
  }
}

/** Default runner group-kill: negative pid first, then a single-pid fallback. */
export function defaultKillRunner(pid: number, signal: NodeJS.Signals): void {
  if (pid > 0) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // fall through
    }
  }
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------

let singleton: RunnerRegistry | undefined

/**
 * The process-wide registry shared by all handlers. Lazily created on first
 * use with the real process hooks. Because the agent imports each handler
 * module once and reuses it, this single instance persists for the session.
 */
export function getRegistry(): RunnerRegistry {
  if (!singleton) {
    singleton = new RunnerRegistry({
      onParentExit: defaultOnParentExit,
      killRunner: defaultKillRunner,
    })
  }
  return singleton
}

/** Test seam: drop the singleton so a test starts from a clean registry. */
export function resetRegistryForTests(): void {
  singleton = undefined
}
