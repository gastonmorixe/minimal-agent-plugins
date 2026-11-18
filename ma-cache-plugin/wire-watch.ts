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
 *   onRequest  parse the body, count the markers. No marker: ignore the request.
 *   onResponse not 2xx: ignore the request. Else note the content-encoding.
 *   onChunk    decode the bytes (gzip when the transport did not inflate them),
 *              and keep the usage fields of `message_start` / `message_delta`.
 *   onEnd      send the final usage and the request facts to the detector.
 *
 * The watcher writes nothing itself. The detector writes through the injected
 * sink.
 *
 * @module cache/wire-watch
 */

import { gunzipSync } from "node:zlib"

import type { CacheAnomalyDetector, CacheUsage, RequestContextSnapshot } from "./detector.ts"
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

/** Largest response body (bytes) kept for one request. Usage is at the start and the end. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

interface Pending {
  snapshot: RequestContextSnapshot
  /** The history epoch at request time (see {@link HistoryEpoch}). */
  epoch: number
  /** Response is 2xx. Unknown until `onResponse`. */
  ok: boolean
  /** Raw response bytes. Decoded at the end. */
  chunks: Uint8Array[]
  size: number
}

/** Usage fields of a Messages response, from SSE text or a JSON body. */
export function extractUsage(text: string): CacheUsage | undefined {
  let usage: CacheUsage | undefined
  const take = (u: unknown): void => {
    if (!u || typeof u !== "object") return
    const rec = u as Record<string, unknown>
    const read = rec.cache_read_input_tokens
    const create = rec.cache_creation_input_tokens
    // `message_delta` usage repeats or adds to `message_start`. The last value wins.
    usage = {
      ...usage,
      ...(typeof read === "number" ? { cache_read_input_tokens: read } : {}),
      ...(typeof create === "number" ? { cache_creation_input_tokens: create } : {}),
    }
  }
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{")) {
    // Not streamed: one JSON message.
    try {
      take((JSON.parse(trimmed) as { usage?: unknown }).usage)
    } catch {
      return undefined
    }
    return usage
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data.includes("usage")) continue
    try {
      const ev = JSON.parse(data) as { usage?: unknown; message?: { usage?: unknown } }
      take(ev.message?.usage)
      take(ev.usage)
    } catch {
      // A malformed line is not a usage line.
    }
  }
  return usage
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

/** Parse a request body. Undefined when it is not a JSON request with markers. */
function requestSnapshot(req: WireRequest): RequestContextSnapshot | undefined {
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
  const snap = snapshotRequest(body, model)
  return snap.breakpoints > 0 ? snap : undefined
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
 */
export function createWireWatch(
  detectorFor: (req: WireRequest, snapshot: RequestContextSnapshot) => CacheAnomalyDetector,
  epoch: HistoryEpoch = () => 0,
): WireObserver {
  const pending = new Map<string, Pending>()
  return {
    onRequest(req) {
      const snapshot = requestSnapshot(req)
      if (snapshot) {
        pending.set(req.id, { snapshot, epoch: epoch(), ok: false, chunks: [], size: 0 })
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
      const usage = extractUsage(decodeBody(p.chunks, p.size))
      // No usage: an aborted or unknown response. It is not a cache fact.
      if (!usage) return
      detectorFor(req, p.snapshot).observe(usage, p.snapshot)
    },
    onError(req) {
      pending.delete(req.id)
    },
  }
}
