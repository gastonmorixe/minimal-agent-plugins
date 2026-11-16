/**
 * Bounded runner for async (fire-and-forget) hooks. Each session key has
 * its own lane: at most `max` tasks of one session run at once (SPEC.md
 * `maxAsync` is per session), and sessions never share a cap. Each lane owns
 * an AbortController. `abort(key)` kills the running tasks of that session and
 * drops its waiting ones. `abortAll()` does it for every lane (engine reset).
 * Context the tasks produce waits in a buffer until the next turn start
 * drains it (SPEC.md "Async hooks").
 *
 * @module engine/async-queue
 */

/** One async task. It gets the abort signal of its session lane. */
export type AsyncTask = (signal: AbortSignal) => Promise<string[]>

interface Lane {
  running: number
  waiting: Array<() => Promise<void>>
  ctl: AbortController
}

/** A per-session concurrency-limited task queue with an output buffer. */
export class AsyncHookQueue {
  /** Lanes per session key (bounded, oldest idle lane dropped first). */
  private readonly lanes = new Map<string, Lane>()
  /** Buffered context per session key (bounded, oldest key dropped first). */
  private readonly output = new Map<string, string[]>()
  private readonly idleWaiters: Array<() => void> = []
  /** Highest number of tasks seen running at once in one lane (diagnostics, tests). */
  peak = 0
  /** Highest number of tasks seen running at once over all lanes (diagnostics, tests). */
  peakTotal = 0

  /**
   * Create a queue.
   *
   * @param max - Max concurrent tasks per session key.
   * @param maxKeys - Max session lanes and output buffers kept.
   */
  constructor(
    readonly max: number,
    readonly maxKeys = 64,
  ) {}

  private lane(key: string): Lane {
    const hit = this.lanes.get(key)
    if (hit) return hit
    const lane: Lane = { running: 0, waiting: [], ctl: new AbortController() }
    this.lanes.set(key, lane)
    this.trimLanes()
    return lane
  }

  /** Drop idle lanes past `maxKeys`. When every lane is busy, abort the oldest. */
  private trimLanes(): void {
    for (const [k, l] of this.lanes) {
      if (this.lanes.size <= this.maxKeys) return
      if (l.running === 0 && l.waiting.length === 0) this.lanes.delete(k)
    }
    while (this.lanes.size > this.maxKeys) {
      const oldest = this.lanes.keys().next().value
      if (oldest === undefined) return
      this.abort(oldest)
      this.lanes.delete(oldest)
    }
  }

  private total(): number {
    let n = 0
    for (const l of this.lanes.values()) n += l.running + l.waiting.length
    return n
  }

  /**
   * Start or queue a task. Never throws. Its returned strings are buffered
   * under `key` (the session id), so one session never drains another's output.
   */
  push(task: AsyncTask, key = ""): void {
    const lane = this.lane(key)
    const signal = lane.ctl.signal
    lane.waiting.push(async () => {
      try {
        const ctx = (await task(signal)).filter((s) => s.trim().length > 0)
        if (ctx.length === 0 || signal.aborted) return
        const buf = this.output.get(key) ?? []
        this.output.delete(key)
        this.output.set(key, [...buf, ...ctx])
        while (this.output.size > this.maxKeys) {
          const oldest = this.output.keys().next().value
          if (oldest === undefined) break
          this.output.delete(oldest)
        }
      } catch {
        // async hooks never fail the agent
      }
    })
    this.pump(lane)
  }

  private pump(lane: Lane): void {
    while (lane.running < this.max && lane.waiting.length > 0) {
      const next = lane.waiting.shift()
      if (!next) break
      lane.running++
      this.peak = Math.max(this.peak, lane.running)
      let all = 0
      for (const l of this.lanes.values()) all += l.running
      this.peakTotal = Math.max(this.peakTotal, all)
      void next().finally(() => {
        lane.running--
        this.pump(lane)
        this.wakeIdle()
      })
    }
  }

  private wakeIdle(): void {
    if (this.total() === 0) for (const w of this.idleWaiters.splice(0)) w()
  }

  /**
   * Abort one session: kill its running tasks (their signal fires), drop
   * its waiting tasks and its buffered output. The next push gets a fresh lane.
   */
  abort(key = ""): void {
    const lane = this.lanes.get(key)
    this.output.delete(key)
    if (!lane) return
    lane.waiting.length = 0
    lane.ctl.abort()
    lane.ctl = new AbortController()
    if (lane.running === 0) this.lanes.delete(key)
    this.wakeIdle()
  }

  /** Abort every session lane (engine dispose or rebuild). */
  abortAll(): void {
    for (const k of [...this.lanes.keys()]) this.abort(k)
    this.output.clear()
  }

  /** Take and clear the buffered context of one session key. */
  drain(key = ""): string[] {
    const buf = this.output.get(key) ?? []
    this.output.delete(key)
    return buf
  }

  /** Resolve when no task runs or waits. */
  idle(): Promise<void> {
    if (this.total() === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }
}
