/**
 * Cache anomaly detector: finds turns where the prompt cache did not work.
 *
 * Input: one {@link CacheFacts} record for each finished request. Today
 * `wire-watch.ts` builds it from the bytes of an Anthropic Messages request
 * and response. Later a provider adapter can report the same facts through a
 * host event (design note:
 * `research/team/walter/2026-11-18-cache-anomaly-per-provider.md`), and this
 * detector stays the same.
 *
 * The rules:
 *
 * - `markers_ignored_cold`, `below_min_block_size`: markers were sent, and
 *   the response read 0 and wrote 0. One warning for each history.
 * - `ttl_expired` (info, not a warning): the previous turn used the cache,
 *   this turn read 0, and the time since the previous response is longer
 *   than the longest marker TTL. The cache expired as documented.
 * - `prefix_changed` (warning): a miss inside the TTL. A full miss is a read
 *   of 0 after a turn that read or wrote. A partial miss is a turn where the
 *   server states a miss reason and the missed tokens are more than the read
 *   tokens. The server reason (Anthropic `cache_miss_reason`) is in the
 *   message when the server sent one.
 * - Streak: misses in a row are counted. The first miss warns, and the
 *   warning comes again at 3, 10, 30, 100, 300, 1000, ... misses, with the
 *   tokens written since the streak started. A turn that reads with no miss
 *   ends the streak.
 *
 * The sink is injected ({@link CacheWarnSink}). The detector writes no
 * terminal text, and each frontend renders the diagnostic.
 *
 * @module cache/detector
 */

/** Stable anomaly codes, for tests, log filters and the ACP notice titles. */
export type AnomalyCode =
  | "markers_ignored_cold" // markers, 0 read and 0 write, prefix above the minimum
  | "below_min_block_size" // markers, 0 read and 0 write, prefix below the minimum
  | "ttl_expired" // a miss after a gap longer than the TTL (info)
  | "prefix_changed" // a miss inside the TTL

/** The server's own statement of a cache miss (Anthropic `diagnostics.cache_miss_reason`). */
export interface CacheMissReason {
  /** The provider's words, for example `messages_changed`. */
  reason: string
  /** Input tokens that the server could not read from the cache. */
  missedTokens?: number
}

/**
 * The facts of one finished request. Only the explicit-marker mechanism is
 * checked today: a request with no marker is not judged.
 */
export interface CacheFacts {
  /** Model id of the request. */
  model: string
  /** Number of `cache_control` markers in the request. */
  markers: number
  /** Approximate prefix size in characters (system, tools, messages). */
  approxPrefixChars: number
  /** Longest marker TTL, in seconds. Undefined: {@link DEFAULT_TTL_SECONDS}. */
  ttlSeconds?: number
  /** Input tokens read from the cache. */
  read: number
  /** Input tokens written to the cache. */
  write: number
  /** The server's miss reason, when it sent one. */
  cacheMiss?: CacheMissReason
  /** Epoch ms when the request started. Undefined: no time check. */
  requestStartedAt?: number
  /** Epoch ms when the response ended. */
  respondedAt?: number
}

/** Structured data of a diagnostic. */
export type CacheDiagData = Readonly<Record<string, string | number | boolean>>

/**
 * Where a diagnostic goes. The plugin passes its `ctx.log`, so the source is
 * `<pluginId>.<source>`. `info` is optional: without it, info diagnostics are
 * dropped.
 */
export interface CacheWarnSink {
  warn(source: string, message: string, sd?: CacheDiagData): void
  info?(source: string, message: string, sd?: CacheDiagData): void
}

/** Options of {@link CacheAnomalyDetector}. */
export interface CacheDetectorOptions {
  /** Diagnostic target. Necessary: the detector has no default bus. */
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

/** Default marker TTL (seconds): an Anthropic `ephemeral` marker without `ttl`. */
export const DEFAULT_TTL_SECONDS = 300

/** True when a streak of `n` misses warns: 1, 3, 10, 30, 100, 300, 1000, ... */
export function isStreakMilestone(n: number): boolean {
  if (n === 1) return true
  for (let m = 1; m <= n; m *= 10) {
    if (m * 3 === n || m * 10 === n) return true
  }
  return false
}

interface ObservedTurn {
  /** 1-based count of all turns in this history. */
  turn: number
  read: number
  write: number
  respondedAt?: number
}

/**
 * Stateful: observe the turns of one history (one session, model and
 * endpoint) in order.
 */
export class CacheAnomalyDetector {
  private prev: ObservedTurn | undefined
  private count = 0
  private readonly warnedOnce = new Set<AnomalyCode>()
  private streak = 0
  private streakWritten = 0
  private readonly sink: CacheWarnSink
  private readonly minPrefixTokens: (model: string) => number

  constructor(opts: CacheDetectorOptions) {
    this.sink = opts.sink
    const lookup = opts.minPrefixTokens
    this.minPrefixTokens = (model) => lookup?.(model) ?? DEFAULT_MIN_PREFIX_TOKENS
  }

  /**
   * Record the result of one request.
   *
   * @returns The codes of this turn. A code can be in the result without a
   *   diagnostic (a one-time code already written, a streak between
   *   milestones, or an info code with no info sink).
   */
  observe(facts: CacheFacts): AnomalyCode[] {
    const turn: ObservedTurn = {
      turn: ++this.count,
      read: facts.read,
      write: facts.write,
      ...(facts.respondedAt !== undefined ? { respondedAt: facts.respondedAt } : {}),
    }
    const prev = this.prev
    this.prev = turn
    const fired: AnomalyCode[] = []
    if (facts.markers <= 0) return fired

    const minTokens = this.minPrefixTokens(facts.model)
    const minChars = minTokens * 4
    const cold = turn.read === 0 && turn.write === 0

    // (a) Markers on a prefix above the minimum, and no read or write.
    if (cold && facts.approxPrefixChars >= minChars) {
      fired.push("markers_ignored_cold")
      this.warnOnce(
        "markers_ignored_cold",
        `cache: request had ${facts.markers} cache_control marker(s) over ~${facts.approxPrefixChars} chars but the API returned 0 read + 0 write. Likely causes: a marker on a sub-threshold block, or the prefix differs from the prior turn (e.g. timestamps or session_id changed).`,
      )
    }

    // (b) Markers on a prefix below the minimum: the cache cannot engage yet.
    if (cold && facts.approxPrefixChars < minChars) {
      fired.push("below_min_block_size")
      this.warnOnce(
        "below_min_block_size",
        `cache: prefix is ~${facts.approxPrefixChars} chars (~${Math.round(facts.approxPrefixChars / 4)} tokens), below this model's ${minTokens}-token cache minimum. Markers are silently ignored until the prefix grows.`,
      )
    }

    // (c) A miss: the previous turn used the cache, and this turn did not
    //     read it (full miss), or the server says it missed more than it read.
    const prevUsed = prev !== undefined && (prev.read > 0 || prev.write > 0)
    const miss = facts.cacheMiss
    const fullMiss = prevUsed && turn.read === 0 && !cold
    const partialMiss =
      prevUsed && turn.read > 0 && miss !== undefined && (miss.missedTokens ?? 0) > turn.read
    if (!prev || (!fullMiss && !partialMiss)) {
      if (turn.read > 0) this.endStreak()
      return fired
    }

    const ttl = facts.ttlSeconds ?? DEFAULT_TTL_SECONDS
    const gapSec =
      facts.requestStartedAt !== undefined && prev.respondedAt !== undefined
        ? (facts.requestStartedAt - prev.respondedAt) / 1000
        : undefined
    if (fullMiss && gapSec !== undefined && gapSec > ttl) {
      // A documented expiry, not a problem. It also ends a miss streak.
      this.endStreak()
      fired.push("ttl_expired")
      this.sink.info?.(
        ANOMALY_SOURCE,
        `cache: turn ${turn.turn} read 0 because the cache expired: ${Math.round(gapSec)} s passed since turn ${prev.turn} ended, and the cache TTL is ${ttl} s. This is expected after an idle time.`,
        { code: "ttl_expired", turn: turn.turn, gapSec: Math.round(gapSec), ttlSec: ttl },
      )
      return fired
    }

    fired.push("prefix_changed")
    this.streak++
    this.streakWritten += turn.write
    if (isStreakMilestone(this.streak)) this.warnMiss(turn, prev, fullMiss, gapSec, ttl, miss)
    return fired
  }

  private warnMiss(
    turn: ObservedTurn,
    prev: ObservedTurn,
    fullMiss: boolean,
    gapSec: number | undefined,
    ttl: number,
    miss: CacheMissReason | undefined,
  ): void {
    const when =
      gapSec !== undefined
        ? `, ${gapSec.toFixed(1)} s after turn ${prev.turn} ended (inside the ${ttl} s TTL)`
        : ""
    const what = fullMiss
      ? `turn ${turn.turn} read 0 cached tokens${when}`
      : `turn ${turn.turn} read ${turn.read} cached tokens but missed ${miss?.missedTokens}${when}`
    const why = miss
      ? `The server says: ${miss.reason}${miss.missedTokens !== undefined ? ` (${miss.missedTokens} tokens missed)` : ""}.`
      : "The request prefix likely changed between turns (a content edit, a changed system block, or removed thinking)."
    const streak =
      this.streak > 1
        ? ` ${this.streak} misses in a row, ${this.streakWritten} tokens written to the cache since the first.`
        : ""
    const sd: Record<string, string | number | boolean> = {
      code: "prefix_changed",
      turn: turn.turn,
      streak: this.streak,
      written: this.streakWritten,
    }
    if (miss) sd.reason = miss.reason
    if (miss?.missedTokens !== undefined) sd.missedTokens = miss.missedTokens
    this.sink.warn(ANOMALY_SOURCE, `cache: ${what}. ${why}${streak}`, sd)
  }

  private endStreak(): void {
    this.streak = 0
    this.streakWritten = 0
  }

  private warnOnce(code: AnomalyCode, message: string): void {
    if (this.warnedOnce.has(code)) return
    this.warnedOnce.add(code)
    this.sink.warn(ANOMALY_SOURCE, message, { code })
  }
}

/** The request side of {@link CacheFacts}, read from a request body. */
export type RequestFacts = Pick<
  CacheFacts,
  "model" | "markers" | "approxPrefixChars" | "ttlSeconds"
>

/** `cache_control.ttl` values, in seconds. */
const TTL_SECONDS: Readonly<Record<string, number>> = { "5m": 300, "1h": 3600 }

/**
 * Walk a request body one time. Count each `cache_control` field (system,
 * tools, messages, nested blocks), keep the longest TTL, and add the text
 * lengths as the prefix size.
 */
export function snapshotRequest(body: unknown, model: string): RequestFacts {
  let markers = 0
  let chars = 0
  let ttlSeconds: number | undefined
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "cache_control" && val) {
        markers++
        const ttl = (val as { ttl?: unknown }).ttl
        const sec = typeof ttl === "string" ? TTL_SECONDS[ttl] : DEFAULT_TTL_SECONDS
        if (sec !== undefined && (ttlSeconds === undefined || sec > ttlSeconds)) ttlSeconds = sec
      } else if ((k === "text" || k === "content") && typeof val === "string") {
        chars += val.length
      } else {
        walk(val)
      }
    }
  }
  walk(body)
  return {
    model,
    markers,
    approxPrefixChars: chars,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  }
}
