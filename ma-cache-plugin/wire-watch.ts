/**
 * Wire watcher: connects the `network:observe` taps to the detector.
 *
 * Every provider request goes through the host network client. This module
 * keeps only the Anthropic Messages shape (a JSON body with `cache_control`
 * markers, and an SSE or JSON response with a `usage` object). Other requests
 * stop at the first check and cost nothing more.
 *
 * Data flow for one request:
 *
 *   onRequest  parse the body one time: count the markers, and hash the prefix
 *              (tools, system, the other request options with the
 *              `anthropic-beta` header, each message), and note where the
 *              assistant thinking is. No marker: ignore the request.
 *              Only the hashes are kept, not the body.
 *   onResponse not 2xx: ignore the request. Else keep the `request-id` header.
 *   onChunk    decode the bytes (gzip when the transport did not inflate them),
 *              and keep the usage fields of `message_start` / `message_delta`.
 *   onEnd      send the facts (request, usage, the server's miss reason, and
 *              the start and end times) to the detector.
 *
 * The watcher writes nothing itself. The detector writes through the injected
 * sink.
 *
 * @module cache/wire-watch
 */

import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"

import type {
  CacheAnomalyDetector,
  CacheFacts,
  CacheMissReason,
  PrefixFingerprint,
  RequestFacts,
} from "./detector.ts"
import { snapshotRequest } from "./detector.ts"

/** The slice of a host wire request this module reads. */
export interface WireRequest {
  readonly id: string
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** The slice of a host wire response this module reads. */
export interface WireResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
}

/** The observer shape of `ctx.host.network.observe`. */
export interface WireObserver {
  onRequest?(req: WireRequest): void
  onResponse?(req: WireRequest, res: WireResponse): void
  onChunk?(req: WireRequest, chunk: Uint8Array): void
  onEnd?(req: WireRequest): void
  onError?(req: WireRequest, error: unknown): void
}

/** The current history epoch. It moves on each reset of the histories. */
export type HistoryEpoch = () => number

/** Wall clock in epoch ms. Injected so tests can set the gap between turns. */
export type Clock = () => number

/** The response side of {@link CacheFacts}, read from the response text. */
export interface ResponseCacheFacts {
  /** Anthropic `cache_read_input_tokens`. */
  read?: number
  /** Anthropic `cache_creation_input_tokens`. */
  write?: number
  /** Anthropic `message.diagnostics.cache_miss_reason` (cache-diagnosis beta). */
  cacheMiss?: CacheMissReason
}

/** Largest response body (bytes) kept for one request. Usage is at the start and the end. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

interface Pending {
  snapshot: RequestFacts
  /** Prefix hashes of the request body. */
  prefix: PrefixFingerprint
  /** The response `request-id` header. Unknown until `onResponse`. */
  requestId?: string
  /** Epoch ms when the request started. */
  startedAt: number
  /** The history epoch at request time (see {@link HistoryEpoch}). */
  epoch: number
  /** Response is 2xx. Unknown until `onResponse`. */
  ok: boolean
  /** Raw response bytes. Decoded at the end. */
  chunks: Uint8Array[]
  size: number
}

/** The miss reason of a `diagnostics` object, or undefined. */
function missOf(diagnostics: unknown): CacheMissReason | undefined {
  if (!diagnostics || typeof diagnostics !== "object") return undefined
  const r = (diagnostics as { cache_miss_reason?: unknown }).cache_miss_reason
  if (!r || typeof r !== "object") return undefined
  const type = (r as { type?: unknown }).type
  if (typeof type !== "string" || type.length === 0) return undefined
  const missed = (r as { cache_missed_input_tokens?: unknown }).cache_missed_input_tokens
  return { reason: type, ...(typeof missed === "number" ? { missedTokens: missed } : {}) }
}

/**
 * Cache facts of a Messages response, from SSE text or a JSON body: the
 * usage counts (`message_delta` repeats or adds to `message_start`, the last
 * value wins) and the server's miss reason (`message_start.message.diagnostics`,
 * or the top-level `diagnostics` of a JSON body).
 *
 * @returns Undefined when the text has no usage: an aborted or unknown response.
 */
export function extractCacheFacts(text: string): ResponseCacheFacts | undefined {
  let facts: ResponseCacheFacts | undefined
  const take = (u: unknown): void => {
    if (!u || typeof u !== "object") return
    const rec = u as Record<string, unknown>
    const read = rec.cache_read_input_tokens
    const write = rec.cache_creation_input_tokens
    facts = {
      ...facts,
      ...(typeof read === "number" ? { read } : {}),
      ...(typeof write === "number" ? { write } : {}),
    }
  }
  let miss: CacheMissReason | undefined
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{")) {
    // Not streamed: one JSON message.
    try {
      const msg = JSON.parse(trimmed) as { usage?: unknown; diagnostics?: unknown }
      take(msg.usage)
      miss = missOf(msg.diagnostics)
    } catch {
      return undefined
    }
  } else {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data.includes("usage") && !data.includes("diagnostics")) continue
      try {
        const ev = JSON.parse(data) as {
          usage?: unknown
          message?: { usage?: unknown; diagnostics?: unknown }
        }
        take(ev.message?.usage)
        take(ev.usage)
        miss = missOf(ev.message?.diagnostics) ?? miss
      } catch {
        // A malformed line is not a usage line.
      }
    }
  }
  if (!facts) return undefined
  return miss ? { ...facts, cacheMiss: miss } : facts
}

/** Decode the response bytes. Gzip only when the bytes have the gzip magic number. */
function decodeBody(chunks: Uint8Array[], size: number): string {
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  // A transport can inflate the body and keep the header (Bun fetch does).
  const gz = all.byteLength >= 2 && all[0] === 0x1f && all[1] === 0x8b
  return new TextDecoder().decode(gz ? gunzipSync(all) : all)
}

/** Assistant content blocks that the client removes from older turns as expected. */
const THINKING_BLOCKS = new Set(["thinking", "redacted_thinking"])

/** A short hash of a JSON value, without its `cache_control` fields. */
function hashOf(value: unknown, onMarker?: () => void): string {
  const text = JSON.stringify(value ?? null, (key, val: unknown) => {
    if (key !== "cache_control") return val
    if (val) onMarker?.()
    return undefined
  })
  return createHash("sha256").update(text).digest("base64url").slice(0, 22)
}

/** Request fields that are not part of the options hash: hashed apart, or not cache-relevant. */
const NOT_OPTIONS = new Set([
  "messages",
  "tools",
  "system",
  "max_tokens",
  "stream",
  "metadata",
  // `diagnostics.previous_message_id` changes on every request.
  "diagnostics",
])

/** The `anthropic-beta` request header (any letter case), as a sorted list. */
function betasOf(headers: Readonly<Record<string, string>> | undefined): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== "anthropic-beta" || !v) continue
    for (const b of v.split(",")) {
      const t = b.trim()
      if (t) out.push(t)
    }
  }
  return out.sort()
}

/**
 * The prefix fingerprint of a parsed request body: a hash of `tools`, a
 * hash of `system`, a hash of the other cache-relevant fields (`options`,
 * with the sorted `anthropic-beta` header when `headers` is given), and one
 * hash for each message. The hashes are computed without `cache_control`.
 * An assistant message is hashed without its thinking blocks, and its index
 * goes to `thinkingAt`.
 */
export function fingerprintRequest(
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): PrefixFingerprint {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const messages: string[] = []
  const thinkingAt: number[] = []
  let lastMarkerIndex = -1
  const list = Array.isArray(b.messages) ? (b.messages as unknown[]) : []
  list.forEach((m, i) => {
    let value = m
    const msg = m as { role?: unknown; content?: unknown } | null
    if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
      const all = msg.content as unknown[]
      const kept = all.filter(
        (c) => !THINKING_BLOCKS.has(String((c as { type?: unknown } | null)?.type)),
      )
      if (kept.length !== all.length) thinkingAt.push(i)
      value = { ...msg, content: kept }
    }
    messages.push(
      hashOf(value, () => {
        lastMarkerIndex = i
      }),
    )
  })
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(b).sort()) if (!NOT_OPTIONS.has(k)) rest[k] = b[k]
  const betas = betasOf(headers)
  return {
    tools: hashOf(b.tools),
    system: hashOf(b.system),
    options: hashOf(betas.length ? { body: rest, betas } : { body: rest }),
    messages,
    lastMarkerIndex,
    thinkingAt,
  }
}

/** The facts of a parsed request: the marker snapshot and the prefix hashes. */
interface RequestParse {
  snapshot: RequestFacts
  prefix: PrefixFingerprint
}

/** Parse a request body. Undefined when it is not a JSON request with markers. */
function parseRequest(req: WireRequest): RequestParse | undefined {
  if (req.method !== "POST" || !req.body.includes("cache_control")) return undefined
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return undefined
  }
  if (!body || typeof body !== "object") return undefined
  const model = (body as { model?: unknown }).model
  if (typeof model !== "string") return undefined
  const snapshot = snapshotRequest(body, model)
  if (snapshot.markers <= 0) return undefined
  return { snapshot, prefix: fingerprintRequest(body, req.headers) }
}

/** The `request-id` response header, with any letter case. */
function requestIdOf(headers: Readonly<Record<string, string>>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "request-id" && v) return v
  }
  return undefined
}

/**
 * Build the wire observer for `ctx.host.network.observe`.
 *
 * @param detectorFor - The detector for a request and its facts. The plugin
 *   keeps one detector for each session, model and endpoint, so two web
 *   sessions do not mix their turns, and a model switch starts a new history.
 * @param epoch - The history epoch. A reset of the histories moves it. A
 *   response is counted only when the epoch did not move after its request
 *   started: a response of the old target that ends after a switch is not
 *   part of the new history. Default: one epoch, no resets.
 * @param now - Wall clock for the request start and response end times.
 */
export function createWireWatch(
  detectorFor: (req: WireRequest, snapshot: RequestFacts) => CacheAnomalyDetector,
  epoch: HistoryEpoch = () => 0,
  now: Clock = Date.now,
): WireObserver {
  const pending = new Map<string, Pending>()
  return {
    onRequest(req) {
      const parsed = parseRequest(req)
      if (parsed) {
        pending.set(req.id, {
          snapshot: parsed.snapshot,
          prefix: parsed.prefix,
          startedAt: now(),
          epoch: epoch(),
          ok: false,
          chunks: [],
          size: 0,
        })
      }
    },
    onResponse(req, res) {
      const p = pending.get(req.id)
      if (!p) return
      if (res.status < 200 || res.status >= 300) {
        pending.delete(req.id)
        return
      }
      p.ok = true
      const requestId = requestIdOf(res.headers ?? {})
      if (requestId) p.requestId = requestId
    },
    onChunk(req, chunk) {
      const p = pending.get(req.id)
      if (!p?.ok) return
      if (p.size + chunk.byteLength > MAX_BODY_BYTES) {
        pending.delete(req.id)
        return
      }
      p.chunks.push(chunk)
      p.size += chunk.byteLength
    },
    onEnd(req) {
      const p = pending.get(req.id)
      pending.delete(req.id)
      if (!p?.ok || p.size === 0) return
      // The histories were reset while this request was in flight (a target
      // switch). Its usage belongs to the old target: drop it.
      if (p.epoch !== epoch()) return
      const res = extractCacheFacts(decodeBody(p.chunks, p.size))
      // No usage: an aborted or unknown response. It is not a cache fact.
      if (!res) return
      const facts: CacheFacts = {
        ...p.snapshot,
        read: res.read ?? 0,
        write: res.write ?? 0,
        ...(res.cacheMiss ? { cacheMiss: res.cacheMiss } : {}),
        requestStartedAt: p.startedAt,
        respondedAt: now(),
        prefix: p.prefix,
        ...(p.requestId ? { requestId: p.requestId } : {}),
      }
      detectorFor(req, p.snapshot).observe(facts)
    },
    onError(req) {
      pending.delete(req.id)
    },
  }
}
