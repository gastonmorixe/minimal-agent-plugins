/**
 * Wire errors of the Cloud Code Assist backend to host error classes.
 *
 * The backend speaks `google.rpc.Status`:
 *
 * @example
 * ```json
 * {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED",
 *           "details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo",
 *                       "retryDelay":"30s"}]}}
 * ```
 *
 * This module reads that body, maps it to the host classes through
 * `classifyUpstreamError`, and keeps the HTTP status in the message so the
 * host `is401` check finds it. A streaming failure can also arrive as an
 * `error` object inside a 200 stream, so {@link classifyStreamError} handles
 * a thrown value as well.
 *
 * @module llm/providers/antigravity/error-class
 */

import type { StreamErrorEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import {
  classifyUpstreamError,
  type ErrorClassFields,
  tagUpstreamError,
} from "@minimal-agent/core/plugin-api/llm/errors"

/** Google `Status` gRPC code names that carry meaning for the host loop. */
const GRPC_CODES: ReadonlySet<string> = new Set([
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "RESOURCE_EXHAUSTED",
  "QUOTA_EXHAUSTED",
  "MODEL_CAPACITY_EXHAUSTED",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "UNIMPLEMENTED",
])

/** A parsed `google.rpc.Status` body. */
export interface GoogleErrorBody {
  status?: number
  code?: string
  message?: string
  retryAfter?: string | null
  /** `RetryInfo` delay in milliseconds, when the body carries one. */
  retryDelayMs?: number
}

/** One `details[]` entry of a `google.rpc.Status`. */
interface GoogleErrorDetail {
  "@type"?: string
  retryDelay?: string
  quotaResetDelay?: string
  violations?: Array<{ quotaMetric?: string }>
}

/** Read a numeric field that may come as a number or a numeric string. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

/** Turn a protobuf duration such as `"30s"` or `"1.5s"` into milliseconds. */
export function parseGoogleDuration(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  if (!match) return undefined
  return Math.round(Number(match[1]) * 1000)
}

/**
 * Parse a `google.rpc.Status` JSON body without throwing.
 *
 * A non-JSON body (an HTML edge error, a proxy page) returns an empty object:
 * the caller still has the HTTP status.
 *
 * @param body - Raw response text.
 * @returns The status number, the gRPC status name, the message and the
 *   `RetryInfo` delay, each when present.
 */
export function parseGoogleError(body: string): GoogleErrorBody {
  const out: GoogleErrorBody = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return out
  }
  if (typeof parsed !== "object" || parsed === null) return out
  const envelope = (parsed as { error?: unknown }).error
  const source =
    typeof envelope === "object" && envelope !== null
      ? (envelope as Record<string, unknown>)
      : (parsed as Record<string, unknown>)
  const numeric = asNumber(source.code)
  if (numeric !== undefined) out.status = numeric
  if (typeof source.status === "string") out.code = source.status
  if (typeof source.message === "string") out.message = source.message
  const details = source.details
  if (Array.isArray(details)) {
    for (const detail of details as GoogleErrorDetail[]) {
      const delay = parseGoogleDuration(detail?.retryDelay ?? detail?.quotaResetDelay)
      if (delay !== undefined) {
        out.retryAfter = `${delay / 1000}s`
        out.retryDelayMs = delay
        break
      }
    }
  }
  return out
}

/** The host category of a gRPC status name, for a stream error event. */
function categoryOf(
  code: string | undefined,
  status: number | undefined,
): StreamErrorEvent["category"] {
  if (code === "RESOURCE_EXHAUSTED" || code === "MODEL_CAPACITY_EXHAUSTED" || status === 429) {
    return "rate_limit"
  }
  if (code === "QUOTA_EXHAUSTED") return "billing"
  if (code === "UNAUTHENTICATED" || status === 401) return "auth"
  if (code === "PERMISSION_DENIED" || status === 403) return "auth"
  // The gRPC code wins over the number: a proxy can turn a deadline into a 504.
  if (code === "DEADLINE_EXCEEDED") return "timeout"
  if (code === "INTERNAL" || code === "UNAVAILABLE" || (status ?? 0) >= 500) return "overloaded"
  return "api"
}

/**
 * Build a tagged error from a non-2xx response or a stream error object.
 *
 * The message keeps the HTTP status and the gRPC name, so the host `is401`
 * check and the retry log both find what they need.
 *
 * @param status - HTTP status of the response, or the `code` of a stream error.
 * @param body - Raw body text.
 * @param headers - Response headers, for `Retry-After`.
 * @returns An `Error` with the host error class fields attached.
 */
export function taggedAntigravityError(
  status: number,
  body: string,
  headers?: { get(name: string): string | null } | null,
): Error & ErrorClassFields & { streamErrorType?: string } {
  const parsed = parseGoogleError(body)
  const upstreamCode =
    parsed.code ?? (parsed.status !== undefined ? String(parsed.status) : undefined)
  const detail = parsed.message ? `: ${parsed.message}` : ""
  const label = parsed.code ?? "error"
  const err = new Error(`Google Antigravity API ${status} ${label}${detail}`) as Error &
    ErrorClassFields & { streamErrorType?: string; status?: number }
  err.status = status
  // A `RetryInfo` delay is a protobuf duration, not a `Retry-After` header, so
  // it becomes a whole number of seconds the host parser accepts.
  const headerWait = headers?.get("retry-after") ?? null
  const retryAfter =
    headerWait ?? (parsed.retryDelayMs !== undefined ? String(parsed.retryDelayMs / 1000) : null)
  const classified = classifyUpstreamError({
    httpStatus: status,
    upstreamCode,
    retryAfter,
    ...(isContextOverflow(parsed.message) ? { contextOverflow: true } : {}),
  })
  return tagUpstreamError(err, classified)
}

/** True when the backend message names a prompt that is too long. */
function isContextOverflow(message: string | undefined): boolean {
  if (!message) return false
  return /input token count|too long|exceeds the maximum|context window/i.test(message)
}

/**
 * Map a thrown value of a streaming loop to a canonical `stream_error`.
 *
 * An error already tagged by {@link taggedAntigravityError} keeps its class.
 * Any other value becomes a retryable `api` error, because a broken stream is
 * usually a transient transport fault.
 *
 * @param err - The value the stream threw.
 * @returns A `stream_error` event for the adapter to yield.
 */
export function classifyStreamError(err: unknown): StreamErrorEvent {
  const message = err instanceof Error ? err.message : String(err)
  const statusMatch = /\b(\d{3})\b/.exec(message)
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined
  const codeMatch = /\b([A-Z][A-Z_]{4,})\b/.exec(message)
  const code = codeMatch?.[1]
  const known = code && GRPC_CODES.has(code) ? code : undefined
  const category = categoryOf(known, httpStatus)
  const retryable = category === "rate_limit" || category === "overloaded" || category === "timeout"
  const event: StreamErrorEvent = { type: "stream_error", retryable, category, cause: err }
  if (known) event.upstreamType = known
  return event
}
