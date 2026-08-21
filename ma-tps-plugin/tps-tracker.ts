/**
 * Pure TPS computation from STREAMED output-delta events. No I/O, no env
 * reads, no clocks — time comes in as sample timestamps, so tests inject
 * values freely.
 *
 * Data source (see DESIGN.md): the host emits `llm.outputDelta`
 * `{deltaTokens}` per batched stream chunk. Unlike session-token counters
 * (which fold once per API call), this advances DURING generation, so a
 * windowed rate over these deltas is a genuine live decode rate.
 *
 * Semantics:
 *   - Each delta is `(tMs, tokens)` pushed into a sliding window of
 *     `windowMs` (default 10s). The reported rate is
 *       (tokens_in_window) / (newest_t - oldest_t)
 *     over the window's span.
 *   - A window span under `minSpanMs` (default 1000ms) has too little
 *     signal; the previous display is HELD instead of blanking (sticky
 *     display — flapping visible/hidden was explicitly rejected).
 *   - Idle: no delta for `idleMs` (default 2500ms) → inactive. Fallback
 *     for a missed `llm.outputEnd`. The host emits that once in the
 *     stream `finally` (before tool IO); the plugin then calls
 *     {@link markInactive} so a long tool run never hangs a stale rate.
 *
 * @module tps/tps-tracker
 */

/** Knobs for {@link TpsTracker}. All optional. */
export interface TpsTrackerOpts {
  /** Sliding-window length in ms. Default 10_000. */
  windowMs?: number
  /**
   * Hide the readout after this many ms without any delta. Default 2500:
   * fallback for a missed `llm.outputEnd`. Primary hide is
   * {@link TpsTracker.markInactive}.
   */
  idleMs?: number
  /** Minimum window span (ms) before a rate is computed. Default 1000. */
  minSpanMs?: number
}

/**
 * What the tracker reports after each sample: the windowed rate (rounded
 * for display) and whether the readout should be visible.
 */
export interface TpsReading {
  /** Tokens per second over the window, rounded to an integer. */
  readonly tps: number
  /** False once no delta has arrived for `idleMs`. */
  readonly active: boolean
}

interface Delta {
  t: number
  tokens: number
}

/**
 * Sliding-window TPS state machine over streamed delta batches. Feed
 * {@link sample} on each `llm.outputDelta` event; read the display value
 * via {@link read} on the slot's own cadence.
 */
export class TpsTracker {
  private readonly windowMs: number
  private readonly idleMs: number
  private readonly minSpanMs: number
  private deltas: Delta[] = []
  private lastTMs: number | null = null
  private lastDeltaTMs: number | null = null
  /** Last rate shown. Held across sub-minSpan windows so the segment
   * doesn't flap; updated whenever a fresh rate computes. */
  private displayed: number | null = null

  constructor(opts: TpsTrackerOpts = {}) {
    this.windowMs = opts.windowMs ?? 10_000
    this.idleMs = opts.idleMs ?? 2_500
    this.minSpanMs = opts.minSpanMs ?? 1000
  }

  /**
   * Feed one streamed delta batch. `tMs` must be non-decreasing across
   * calls (monotonic clock semantics); out-of-order calls are ignored as
   * noise.
   */
  sample(tMs: number, deltaTokens: number): TpsReading {
    if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return this.read(tMs)
    if (this.lastTMs !== null && tMs < this.lastTMs) return this.read(tMs)
    this.lastTMs = tMs

    this.deltas.push({ t: tMs, tokens: deltaTokens })
    this.lastDeltaTMs = tMs

    // Trim deltas older than the window.
    const cutoff = tMs - this.windowMs
    let drop = 0
    while (drop < this.deltas.length - 1 && this.deltas[drop]!.t < cutoff) drop += 1
    if (drop > 0) this.deltas.splice(0, drop)

    return this.read(tMs)
  }

  /**
   * Current reading against `nowMs`, without recording a new sample. The
   * slot handler calls this on its own cadence; delta events arrive via
   * {@link sample}.
   *
   * STICKY DISPLAY: when the window span is under `minSpanMs` there isn't
   * enough signal to recompute, so the previous rate is held rather than
   * blanking the segment.
   */
  read(nowMs: number): TpsReading {
    const active = this.lastDeltaTMs !== null && nowMs - this.lastDeltaTMs <= this.idleMs
    if (!active) {
      this.displayed = null
      return { tps: 0, active }
    }
    if (this.deltas.length >= 2) {
      const newest = this.deltas.at(-1)!
      const oldest = this.deltas[0]!
      const dtSec = (newest.t - oldest.t) / 1000
      if (dtSec >= this.minSpanMs / 1000) {
        let total = 0
        // Sum all deltas EXCEPT the oldest — its tokens were generated
        // BEFORE `oldest.t`, so counting them over a span that starts at
        // oldest.t would inflate the rate.
        for (let i = 1; i < this.deltas.length; i++) total += this.deltas[i]!.tokens
        this.displayed = Math.round(total / dtSec)
      }
      // else: span too short — hold the previous display.
    }
    return { tps: this.displayed ?? 0, active }
  }

  /**
   * Host said generation stopped (`llm.outputEnd`, once in stream
   * `finally`). Hide immediately instead of waiting out `idleMs`.
   * Idempotent.
   */
  markInactive(): TpsReading {
    this.deltas = []
    this.lastTMs = null
    this.lastDeltaTMs = null
    this.displayed = null
    return { tps: 0, active: false }
  }

  /** Drop all state (new session). */
  reset(): void {
    this.markInactive()
  }
}
