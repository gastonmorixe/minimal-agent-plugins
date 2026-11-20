/**
 * FIFO cap on one-shot backend processes.
 *
 * Fetch calls without a named session are concurrency-safe, so core can run
 * them at the same time. Each one-shot call starts its own render process
 * (`bun backends/obscura.ts` + `obscura`). One page can use 2.3 GB of RSS
 * (nytimes.com, measured), and 10 calls at the same time used 3.7 GB. This
 * semaphore lets at most N one-shot processes run at the same time. Other
 * calls wait in arrival order.
 *
 * Rules:
 *   - A call gets its slot BEFORE its process starts. The per-call timeout
 *     and the outer watchdog start in `callBackend`, after the slot.
 *   - An abort while a call waits removes the call from the queue. The
 *     call then owns no slot and releases nothing.
 *   - A call that owns a slot must release it in `finally`. `release` is
 *     idempotent, so a second call to it has no effect.
 */

/** Default number of one-shot processes that can run at the same time. */
export const DEFAULT_FETCH_MAX_CONCURRENT = 4

/** Env name that overrides {@link DEFAULT_FETCH_MAX_CONCURRENT}. */
export const FETCH_MAX_CONCURRENT_ENV = "MINIMAL_AGENT_FETCH_MAX_CONCURRENT"

/**
 * Read the cap from the env. A value must be an integer of 1 or more (digits only).
 * All other values give the default.
 */
export function resolveFetchMaxConcurrent(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env[FETCH_MAX_CONCURRENT_ENV]?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_FETCH_MAX_CONCURRENT
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_FETCH_MAX_CONCURRENT
}

/** A slot that a call owns. Call `release` one time, in `finally`. */
export interface SlotLease {
  release(): void
}

interface Waiter {
  grant: (lease: SlotLease) => void
}

/** FIFO counting semaphore. Waiters get a slot in arrival order. */
export class FifoSemaphore {
  private active = 0
  private readonly queue: Waiter[] = []

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("max must be an integer of 1 or more")
  }

  /** Number of slots in use. */
  get running(): number {
    return this.active
  }

  /** Number of calls that wait for a slot. */
  get waiting(): number {
    return this.queue.length
  }

  /**
   * Get a slot. Gives `null` if `signal` aborts before the slot comes. In
   * that case the call owns nothing and must not release.
   */
  acquire(signal?: AbortSignal): Promise<SlotLease | null> {
    if (signal?.aborted) return Promise.resolve(null)
    if (this.active < this.max && this.queue.length === 0) {
      this.active++
      return Promise.resolve(this.lease())
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        const i = this.queue.indexOf(waiter)
        if (i !== -1) this.queue.splice(i, 1)
        resolve(null)
      }
      const waiter: Waiter = {
        grant: (lease) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(lease)
        },
      }
      this.queue.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private lease(): SlotLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.handOff()
      },
    }
  }

  /** Give the freed slot to the first waiter, or make it free. */
  private handOff(): void {
    const next = this.queue.shift()
    if (next) {
      // The slot moves to the waiter. `active` does not change.
      next.grant(this.lease())
      return
    }
    this.active--
  }
}

let moduleSlots: FifoSemaphore | null = null

/** The process-local cap on one-shot Fetch processes. The env is read one time. */
export function oneShotSlots(): FifoSemaphore {
  moduleSlots ??= new FifoSemaphore(resolveFetchMaxConcurrent())
  return moduleSlots
}

/** Test-only: forget the module semaphore, so the next use reads the env again. */
export function resetOneShotSlotsForTest(): void {
  moduleSlots = null
}
