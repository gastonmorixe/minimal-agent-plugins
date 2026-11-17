/**
 * Cache anomaly detector: finds turns where the prompt cache did not work.
 *
 * Ported from core `src/cache/cache.ts` (deleted in core S44, decision 14).
 * Changes from the core version:
 *
 * - The warning sink is injected ({@link CacheWarnSink}). The detector does
 *   not import a diagnostics bus, and it writes no terminal text. Each
 *   frontend renders the diagnostic.
 * - The per-model cache minimum is injected ({@link CacheDetectorOptions.minPrefixTokens}),
 *   so the detector does not import the model registry.
 *
 * The detector reads the Anthropic Messages usage fields
 * (`cache_read_input_tokens`, `cache_creation_input_tokens`) and the
 * `cache_control` markers of the request body. A provider on another wire
 * shape sends no markers, so the detector ignores its requests.
 *
 * @module cache/detector
 */

/** Stable anomaly codes, for tests and log filters. */
export type AnomalyCode =
  | "markers_ignored_cold" // request had markers, response had 0 read + 0 write
  | "no_read_after_write" // turn N+1 did not read what turn N wrote
  | "cache_evicted" // cache_read climbed, then fell to 0
  | "below_min_block_size" // prefix is below the per-model cache minimum

/** The usage fields the detector reads. */
export interface CacheUsage {
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** The facts of the request that produced the usage. */
export interface RequestContextSnapshot {
  /** Number of `cache_control` markers in the request. */
  breakpoints: number
  /** Approximate prefix size in characters (system, tools, messages). */
  approxPrefixChars: number
  /** Model id of the request. */
  model: string
}

/**
 * Where a warning goes. The plugin passes its `ctx.log`, so the warning is a
 * warn-severity diagnostic with source `<pluginId>.<source>`.
 */
export interface CacheWarnSink {
  warn(
    source: string,
    message: string,
    sd?: Readonly<Record<string, string | number | boolean>>,
  ): void
}

/** Options of {@link CacheAnomalyDetector}. */
export interface CacheDetectorOptions {
  /** Warning target. Necessary: the detector has no default bus. */
  sink: CacheWarnSink
  /**
   * Cache minimum of a model, in tokens. Return `undefined` when the model
   * is not known. Default: no lookup (the 1024-token fallback).
   */
  minPrefixTokens?: (model: string) => number | undefined
}

/** The diagnostic source the detector writes, relative to the plugin id. */
export const ANOMALY_SOURCE = "anomaly"

/** Fallback cache minimum (tokens), when the registry does not know the model. */
export const DEFAULT_MIN_PREFIX_TOKENS = 1024

interface ObservedTurn {
  turn: number
  read: number
  create: number
  hadMarkers: boolean
  approxPrefixChars: number
}

/**
 * Stateful: observe the turns of one conversation in order. The detector
 * compares each turn with the turns before it. It writes each anomaly code
 * at most one time.
 */
export class CacheAnomalyDetector {
  private turns: ObservedTurn[] = []
  private readonly warnedCodes = new Set<AnomalyCode>()
  private readonly sink: CacheWarnSink
  private readonly minPrefixTokens: (model: string) => number

  constructor(opts: CacheDetectorOptions) {
    this.sink = opts.sink
    const lookup = opts.minPrefixTokens
    this.minPrefixTokens = (model) => lookup?.(model) ?? DEFAULT_MIN_PREFIX_TOKENS
  }

  /**
   * Record the result of one turn.
   *
   * @returns The anomaly codes of this turn. A code can be in the result
   *   when its warning was already written on an earlier turn.
   */
  observe(usage: CacheUsage, ctx: RequestContextSnapshot): AnomalyCode[] {
    const turn: ObservedTurn = {
      turn: this.turns.length + 1,
      read: usage.cache_read_input_tokens ?? 0,
      create: usage.cache_creation_input_tokens ?? 0,
      hadMarkers: ctx.breakpoints > 0,
      approxPrefixChars: ctx.approxPrefixChars,
    }
    this.turns.push(turn)
    // Only the last three turns count.
    if (this.turns.length > 3) this.turns.shift()

    const fired: AnomalyCode[] = []
    const minTokens = this.minPrefixTokens(ctx.model)
    const minChars = minTokens * 4
    const cold = turn.hadMarkers && turn.read === 0 && turn.create === 0

    // (a) Markers, a prefix above the minimum, and no read or write: the API
    //     ignored the markers, or the prefix changed.
    if (cold && turn.approxPrefixChars >= minChars) {
      fired.push("markers_ignored_cold")
      this.maybeWarn(
        "markers_ignored_cold",
        `cache: request had ${ctx.breakpoints} cache_control marker(s) over ~${turn.approxPrefixChars} chars but the API returned 0 read + 0 write. Likely causes: a marker on a sub-threshold block, or the prefix differs from the prior turn (e.g. timestamps or session_id changed).`,
      )
    }

    // (b) Markers on a prefix below the minimum: the cache cannot engage yet.
    if (cold && turn.approxPrefixChars < minChars) {
      fired.push("below_min_block_size")
      this.maybeWarn(
        "below_min_block_size",
        `cache: prefix is ~${turn.approxPrefixChars} chars (~${Math.round(turn.approxPrefixChars / 4)} tokens), below this model's ${minTokens}-token cache minimum. Markers are silently ignored until the prefix grows.`,
      )
    }

    const prev = this.turns.at(-2)
    // (c) Turn N wrote the cache, so turn N+1 must read it.
    if (prev && prev.create > 0 && turn.read === 0 && turn.hadMarkers) {
      fired.push("no_read_after_write")
      this.maybeWarn(
        "no_read_after_write",
        `cache: turn ${prev.turn} wrote ${prev.create} tokens to cache but turn ${turn.turn} read 0. The prefix likely changed between turns (a content edit, a new system block, or a different session_id).`,
      )
    }

    // (d) cache_read climbed, then fell to 0: eviction or a prefix change.
    const before = this.turns.at(-3)
    if (prev && before && before.read > 0 && prev.read > 0 && turn.read === 0) {
      fired.push("cache_evicted")
      this.maybeWarn(
        "cache_evicted",
        `cache: cache_read collapsed to 0 after climbing across prior turns (${before.read} → ${prev.read} → 0). The cached prefix was likely evicted (TTL expired) or the request prefix changed.`,
      )
    }

    return fired
  }

  private maybeWarn(code: AnomalyCode, message: string): void {
    if (this.warnedCodes.has(code)) return
    this.warnedCodes.add(code)
    this.sink.warn(ANOMALY_SOURCE, message, { code })
  }
}

/**
 * Walk a request body one time. Count each `cache_control` field (system,
 * tools, messages, nested blocks), and add the text lengths as the prefix
 * size.
 */
export function snapshotRequest(body: unknown, model: string): RequestContextSnapshot {
  let breakpoints = 0
  let chars = 0
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "cache_control" && val) breakpoints++
      else if ((k === "text" || k === "content") && typeof val === "string") chars += val.length
      else walk(val)
    }
  }
  walk(body)
  return { breakpoints, approxPrefixChars: chars, model }
}
