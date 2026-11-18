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
 * - `prefix_changed` (warning): a miss inside the TTL that the client caused.
 *   A full miss is a read of 0 after a turn that read or wrote. A partial
 *   miss is a turn where the server states a miss reason and its
 *   server-reported miss size is more than the read tokens. When both turns
 *   have a {@link PrefixFingerprint}, the message names the changed part:
 *   the tools, the system prompt, the request options, the first changed
 *   message, or a message whose thinking was removed. The server reason
 *   (Anthropic `cache_miss_reason`) is a hint in the message.
 * - `server_miss` (info): a read of 0 inside the TTL, but the prefix did not
 *   change: the tools, the system prompt, the request options and each
 *   message up to the last cache marker of the previous request are equal
 *   (without `cache_control`, and without the thinking of the previous
 *   latest assistant message, which the client removes as expected). It
 *   needs one more fact: no thinking was removed, or the previous request
 *   read its prefix (read at least 90% of read + write). It is likely a
 *   server-side miss, not a proven one. It does not start, extend or end a
 *   `prefix_changed` streak.
 * - The thinking removal and the server's lookback: when the client removes
 *   the thinking of the previous latest assistant message, the entry of the
 *   previous request becomes unreachable, and the server reads an older
 *   entry (it looks back a limited number of positions from the marker).
 *   If the previous request did not read its prefix either, the older
 *   entries can be out of reach: a read of 0 with an unchanged prefix is
 *   then `prefix_changed` ("thinking removal + cache lookback"). A partial
 *   read with the server reason `messages_changed` and an unchanged prefix
 *   gives no diagnostic only when the turn wrote at most 10% of its prompt
 *   (read + write). Else the read stays on an older entry and the turn is
 *   `prefix_changed`.
 * - Streak: misses in a row are counted. The first miss warns, and the
 *   warning comes again at 3, 10, 30, 100, 300, 1000, ... misses, with the
 *   tokens written since the streak started. A turn that reads with no miss
 *   ends the streak.
 *
 * The server's `cache_missed_input_tokens` is shown as the "server-reported
 * miss size". It is not the number of tokens lost: the server also reports
 * it on turns that read most of the prefix. The real cost of a miss is the
 * tokens written again.
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
  | "prefix_changed" // a miss inside the TTL that the client caused
  | "server_miss" // a read of 0 inside the TTL with an unchanged prefix (info)

/** The server's own statement of a cache miss (Anthropic `diagnostics.cache_miss_reason`). */
export interface CacheMissReason {
  /** The provider's words, for example `messages_changed`. */
  reason: string
  /**
   * The server-reported miss size (`cache_missed_input_tokens`). It is not
   * the number of tokens lost: the tokens written are the real cost.
   */
  missedTokens?: number
}

/**
 * A small fingerprint of the cacheable prefix of one request. It keeps only
 * hashes, so a history does not keep a large request body between turns.
 * Each hash is computed without the `cache_control` fields. A message hash
 * of an assistant message is also computed without its `thinking` and
 * `redacted_thinking` blocks: {@link PrefixFingerprint.thinkingAt} records
 * where they were, so {@link comparePrefix} can tell the expected removal
 * (the previous latest assistant message) from any other removal.
 */
export interface PrefixFingerprint {
  /** Hash of `tools`. */
  tools: string
  /** Hash of `system`. */
  system: string
  /**
   * Hash of the other request fields that change the cache (`thinking`,
   * `output_config`, `context_management`, `tool_choice`, ..., and the
   * sorted `anthropic-beta` request header). Without `messages`, `tools`,
   * `system`, `max_tokens`, `stream`, `metadata` and `diagnostics`.
   * Undefined: not compared.
   */
  options?: string
  /** One hash for each message, in order. */
  messages: readonly string[]
  /** Index of the last message with a `cache_control` marker. -1: none. */
  lastMarkerIndex: number
  /**
   * Indexes of the assistant messages that had a thinking block, in order.
   * Undefined: thinking removals are not checked.
   */
  thinkingAt?: readonly number[]
}

/** The first difference of two fingerprints, from {@link comparePrefix}. */
export type PrefixDiff =
  /**
   * Equal up to `upTo`. `strippedAt`: the client removed the thinking of
   * the previous latest assistant message, at this index (the expected
   * removal). Undefined: no thinking was removed in `0..upTo`.
   */
  | { kind: "same"; upTo: number; strippedAt?: number }
  | { kind: "tools" | "system" | "tools_system" | "options" }
  | { kind: "message"; index: number; removed: boolean }
  /** The thinking of an older assistant message was removed (not the expected one). */
  | { kind: "thinking"; index: number }

/**
 * Compare the prefix of a request with the prefix of the request before it.
 * Messages are compared up to the last marker index of the previous
 * request: the server can read only an entry that ends at a marker. A
 * thinking removal counts as expected only at the previous latest assistant
 * message with thinking (`max(prev.thinkingAt)`).
 */
export function comparePrefix(prev: PrefixFingerprint, cur: PrefixFingerprint): PrefixDiff {
  const tools = prev.tools !== cur.tools
  const system = prev.system !== cur.system
  if (tools && system) return { kind: "tools_system" }
  if (tools) return { kind: "tools" }
  if (system) return { kind: "system" }
  if (prev.options !== undefined && cur.options !== undefined && prev.options !== cur.options) {
    return { kind: "options" }
  }
  const prevThinking = new Set(prev.thinkingAt ?? [])
  const curThinking = cur.thinkingAt ? new Set(cur.thinkingAt) : undefined
  const expected = prev.thinkingAt?.length ? prev.thinkingAt[prev.thinkingAt.length - 1] : undefined
  let strippedAt: number | undefined
  for (let i = 0; i <= prev.lastMarkerIndex; i++) {
    if (i >= cur.messages.length) return { kind: "message", index: i, removed: true }
    if (prev.messages[i] !== cur.messages[i]) return { kind: "message", index: i, removed: false }
    if (curThinking && prevThinking.has(i) && !curThinking.has(i)) {
      if (i !== expected) return { kind: "thinking", index: i }
      strippedAt = i
    }
  }
  return {
    kind: "same",
    upTo: prev.lastMarkerIndex,
    ...(strippedAt !== undefined ? { strippedAt } : {}),
  }
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
  /** Prefix hashes of the request. Undefined: the miss cause is not checked. */
  prefix?: PrefixFingerprint
  /** The response `request-id` header, when the host gave it. */
  requestId?: string
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
  prefix?: PrefixFingerprint
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
      ...(facts.prefix ? { prefix: facts.prefix } : {}),
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

    const diff = prev.prefix && facts.prefix ? comparePrefix(prev.prefix, facts.prefix) : undefined
    let cause: ClientCause | undefined
    if (diff?.kind === "same") {
      // The thinking removal is known to be absent only when both turns
      // recorded where their thinking was.
      const noStrip =
        diff.strippedAt === undefined &&
        prev.prefix?.thinkingAt !== undefined &&
        facts.prefix?.thinkingAt !== undefined
      if (partialMiss) {
        // The server reports `messages_changed` after the expected thinking
        // removal and reads a shorter entry. A normal cost while the turn
        // writes little. A large write means the read stays on an older
        // entry and each turn writes its history again.
        if (miss?.reason === "messages_changed") {
          if (turn.write <= SMALL_WRITE_FRACTION * (turn.read + turn.write)) {
            this.endStreak()
            return fired
          }
          if (diff.strippedAt !== undefined) cause = "older_entry"
        }
      } else if (noStrip || readItsPrefix(prev)) {
        // The prefix did not change, and either no thinking was removed or
        // the previous request read its own prefix (so an entry near the
        // marker was alive). Likely a server-side miss. Not a client
        // change: the prefix_changed streak stays as it is.
        fired.push("server_miss")
        this.infoServerMiss(
          { turn, prev, fullMiss, gapSec, ttl, miss, diff },
          facts.requestId,
          noStrip,
        )
        return fired
      } else {
        // The thinking removal made the previous entry unreachable, and the
        // previous request did not read its prefix either: the entries that
        // the server's lookback can reach are gone.
        cause = "lookback"
      }
    }

    const ctx: MissContext = { turn, prev, fullMiss, gapSec, ttl, miss, diff, cause }
    fired.push("prefix_changed")
    this.streak++
    this.streakWritten += turn.write
    if (isStreakMilestone(this.streak)) this.warnMiss(ctx)
    return fired
  }

  private infoServerMiss(c: MissContext, requestId: string | undefined, noStrip: boolean): void {
    const upTo = c.diff?.kind === "same" ? c.diff.upTo : -1
    const msgs = upTo >= 0 ? `, and messages 0..${upTo}` : ""
    const id = requestId ? ` Request id: ${requestId}.` : ""
    const why = noStrip ? "no thinking was removed" : "the previous request read its cache"
    const sd: Record<string, string | number | boolean> = {
      code: "server_miss",
      turn: c.turn.turn,
      written: c.turn.write,
      lastMarkerIndex: upTo,
    }
    if (c.gapSec !== undefined) sd.gapSec = Math.round(c.gapSec * 10) / 10
    if (c.miss) sd.reason = c.miss.reason
    if (c.miss?.missedTokens !== undefined) sd.missedTokens = c.miss.missedTokens
    if (requestId) sd.requestId = requestId
    this.sink.info?.(
      ANOMALY_SOURCE,
      `cache: ${missWhat(c)}. This is likely a server-side miss: the prefix up to the previous marker is unchanged and ${why} (the tools, the system prompt${msgs} are equal to turn ${c.prev.turn}, not counting the expected thinking removal).${serverHint(c.miss)}${id}`,
      sd,
    )
  }

  private warnMiss(c: MissContext): void {
    const streak =
      this.streak > 1
        ? ` ${this.streak} misses in a row, ${this.streakWritten} tokens written to the cache since the first.`
        : ""
    const sd: Record<string, string | number | boolean> = {
      code: "prefix_changed",
      turn: c.turn.turn,
      streak: this.streak,
      written: this.streakWritten,
    }
    if (c.miss) sd.reason = c.miss.reason
    if (c.miss?.missedTokens !== undefined) sd.missedTokens = c.miss.missedTokens
    if (c.diff && c.diff.kind !== "same") {
      sd.changed = c.diff.kind
      if (c.diff.kind === "message" || c.diff.kind === "thinking") sd.changedIndex = c.diff.index
    } else if (c.cause && c.diff?.kind === "same") {
      sd.changed = c.cause === "lookback" ? "thinking_lookback" : "thinking_older_entry"
      if (c.diff.strippedAt !== undefined) sd.changedIndex = c.diff.strippedAt
    }
    this.sink.warn(ANOMALY_SOURCE, `cache: ${missWhat(c)}. ${missWhy(c)}${streak}`, sd)
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

/** The data of one miss, for the diagnostic text. */
interface MissContext {
  turn: ObservedTurn
  prev: ObservedTurn
  fullMiss: boolean
  gapSec: number | undefined
  ttl: number
  miss: CacheMissReason | undefined
  diff: PrefixDiff | undefined
  /** The client-side cause of a miss with an unchanged prefix (see {@link ClientCause}). */
  cause?: ClientCause
}

/**
 * The client-side cause of a miss when the prefix is unchanged except for
 * the expected thinking removal:
 * - `lookback`: a read of 0, and the previous request did not read its
 *   prefix. No entry is in reach of the server's lookback.
 * - `older_entry`: a partial read that wrote more than
 *   {@link SMALL_WRITE_FRACTION} of the prompt. The read stays on an older
 *   entry.
 */
type ClientCause = "lookback" | "older_entry"

/** A partial read after the thinking removal is normal up to this write fraction. */
export const SMALL_WRITE_FRACTION = 0.1

/** A request "read its prefix" when it read at least this fraction of read + write. */
export const READ_PREFIX_FRACTION = 0.9

/** True when the turn read at least {@link READ_PREFIX_FRACTION} of its cached prompt. */
function readItsPrefix(t: ObservedTurn): boolean {
  return t.read >= READ_PREFIX_FRACTION * (t.read + t.write)
}

/** The first sentence of a miss: the reads, the gap and the tokens written. */
function missWhat(c: MissContext): string {
  const when =
    c.gapSec !== undefined
      ? `, ${c.gapSec.toFixed(1)} s after turn ${c.prev.turn} ended (inside the ${c.ttl} s TTL)`
      : ""
  const read = c.fullMiss
    ? `turn ${c.turn.turn} read 0 cached tokens${when}`
    : `turn ${c.turn.turn} read ${c.turn.read} cached tokens, less than the server-reported miss size of ${c.miss?.missedTokens}${when}`
  return `${read}, and wrote ${c.turn.write} tokens to the cache`
}

/** The server's reason as a hint, with the server-reported miss size. */
function serverHint(miss: CacheMissReason | undefined): string {
  if (!miss) return ""
  const size =
    miss.missedTokens !== undefined
      ? ` (server-reported miss size: ${miss.missedTokens} tokens)`
      : ""
  return ` The server says: ${miss.reason}${size}.`
}

/** The cause of a client-side miss: the changed part, then the server hint. */
function missWhy(c: MissContext): string {
  const since = `since turn ${c.prev.turn}`
  const d = c.diff
  let cause: string
  if (d?.kind === "tools_system") cause = `The tools and the system prompt changed ${since}.`
  else if (d?.kind === "tools") cause = `The tools changed ${since}.`
  else if (d?.kind === "system") cause = `The system prompt changed ${since}.`
  else if (d?.kind === "options") {
    cause = `The request options changed ${since} (for example thinking, output_config, context_management, tool_choice, or the anthropic-beta header).`
  } else if (d?.kind === "message") {
    cause = d.removed
      ? `Message ${d.index} was removed ${since} (the history became shorter).`
      : `Message ${d.index} changed ${since} (the first changed message, not counting the removed thinking).`
  } else if (d?.kind === "thinking") {
    cause = `Thinking removed from message ${d.index} ${since} (only the removal from the previous latest assistant message is expected).`
  } else if (c.cause === "lookback") {
    cause = `Thinking removal + cache lookback: no reachable cache entry. The prefix is unchanged except the expected thinking removal, but turn ${c.prev.turn} did not read its own prefix either, so no older entry was in reach.`
  } else if (c.cause === "older_entry") {
    cause = `Thinking removal; the read stays on an older entry, so this turn wrote ${c.turn.write} tokens again.`
  } else if (c.miss) {
    return serverHint(c.miss).trimStart()
  } else {
    return "The request prefix likely changed between turns (a content edit, a changed system block, or removed thinking)."
  }
  return `${cause}${serverHint(c.miss)}`
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
