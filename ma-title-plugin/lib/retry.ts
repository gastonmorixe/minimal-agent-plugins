/**
 * Retry policy of the automatic title: pure functions, no IO and no clock.
 *
 * {@link classifyFailure} puts each failed title call in one of two classes:
 *
 * - `transient`: the provider or the network did not answer (timeout, abort,
 *   connection reset, DNS, HTTP 408, 429 or 5xx, overload, stream stall). The
 *   same request can give a title later. This class uses no attempt. The
 *   plugin tries again after {@link backoffMs}, with no limit.
 * - `final`: the model gave a result that is not usable (a bad stop reason,
 *   invalid JSON, an unusable title, a refusal, a content filter), the host
 *   refused the call (price, model, provider), or the write failed. This
 *   class uses one attempt (`MAX_ATTEMPTS` in `lib/eligibility.ts`).
 *
 * An unknown value is `final`. Thus a new error kind cannot make calls with
 * no limit (cost safety).
 *
 * The values come from core `src/plugins/host/providers/llm-side.ts`. Core
 * `request()` does not throw. A failure is a result with `stopReason` and
 * `reason`. A `transport` failure has the error text in `detail`. The text
 * of a provider HTTP error starts with a label and the status, for example
 * `Anthropic API 529: ...` (the `ma-llm-*` adapters).
 *
 * @module lib/retry
 */

/** The class of a failed title call. */
export type FailureClass = "transient" | "final"

/** One failed title call, as the handler sees it. */
export type FailureInput =
  | {
      /** `request()` gave a result that the plugin cannot use. */
      kind: "result"
      stopReason: string
      /** Core `LlmSideReason`, when set. */
      reason?: string
      /** Core error text (max 200 chars), when set. */
      detail?: string
    }
  | {
      /** `request()` threw (an old host or a bug: core does not throw). */
      kind: "exception"
      error: unknown
    }
  | {
      /** `sessionMeta.setTitle` threw. */
      kind: "write-failed"
      /** `SessionMetaError.code`, when set. */
      code?: string
    }

/** Wait before the next try, by the count of transient failures in a row. */
export const BACKOFF_TABLE_MS: readonly number[] = Object.freeze([
  1 * 60_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
])

/**
 * The wait after the `transientCount`-th transient failure in a row: 1, 2,
 * 5, 15 and 30 minutes, then 60 minutes for each later failure.
 */
export function backoffMs(transientCount: number): number {
  const n = Number.isFinite(transientCount) ? Math.floor(transientCount) : 1
  const i = Math.min(Math.max(n, 1), BACKOFF_TABLE_MS.length) - 1
  return BACKOFF_TABLE_MS[i] ?? BACKOFF_TABLE_MS[BACKOFF_TABLE_MS.length - 1] ?? 60 * 60_000
}

/** Stop reasons of an abort result (core `abortResult`). */
const ABORT_STOPS: ReadonlySet<string> = new Set(["timeout", "aborted"])

/**
 * Connection errors. The same codes as core `src/network/transient-error.ts`
 * (`TRANSIENT_ERROR_CODES`).
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "EPROTO",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

/**
 * Error text of a connection error or a stall. Based on core
 * `TRANSIENT_MESSAGE_PATTERN` (`src/network/transient-error.ts`), plus the
 * watchdog stall text (`src/llm/transport/watchdog.ts`) and the overload and
 * rate limit tags.
 */
const TRANSIENT_TEXT =
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|ENETDOWN|ENETRESET|EHOSTUNREACH|EHOSTDOWN|EADDRNOTAVAIL|EPROTO|ENOTFOUND|EAI_AGAIN)\b|socket hang up|connect timeout|connection timeout|session closed before connect|alpn negotiation failed|client network socket disconnected|other side closed|fetch failed|network (request )?failed|connection reset|connection closed|goaway|stream (was )?(closed|cancelled|canceled|aborted)|premature close|terminated|no response body activity|attempt exceeded|overloaded|rate[_ -]limit|server_error|service_unavailable|timed out/i

/**
 * Billing or quota with no reset. Core `classifyUpstreamError` makes it
 * `permanent`, also on a 429. Waiting does not clear it.
 */
const BILLING_TEXT = /insufficient_quota|billing|quota_exceeded/i

/** The HTTP status in an adapter error text (`<label> <status>: <body>`). */
const STATUS_TEXT = /(?:^|\s)([1-5]\d\d):/

/** The class of an error text (a `transport` detail or a thrown message). */
function classifyText(text: string): FailureClass {
  if (text === "") return "final"
  if (BILLING_TEXT.test(text)) return "final"
  const status = STATUS_TEXT.exec(text)?.[1]
  if (status !== undefined) {
    const n = Number(status)
    return n === 408 || n === 429 || n >= 500 ? "transient" : "final"
  }
  return TRANSIENT_TEXT.test(text) ? "transient" : "final"
}

/** The class of a thrown value. */
function classifyThrown(err: unknown): FailureClass {
  if (err === null || err === undefined) return "final"
  if (typeof err !== "object") return classifyText(String(err))
  const e = err as {
    name?: unknown
    code?: unknown
    errorClass?: unknown
    retryable?: unknown
    message?: unknown
  }
  // An abort of the side call (shutdown, the caller signal, a timeout).
  if (e.name === "AbortError" || e.name === "TimeoutError") return "transient"
  // The class that an adapter put on the error wins.
  if (e.errorClass === "transient") return "transient"
  if (e.errorClass === "permanent" || e.errorClass === "recoverable") return "final"
  if (e.retryable === false) return "final"
  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return "transient"
  return classifyText(typeof e.message === "string" ? e.message : "")
}

/** The class of one failed title call. An unknown value is `final`. */
export function classifyFailure(input: FailureInput): FailureClass {
  switch (input.kind) {
    case "write-failed":
      // `not-owned`, `no-session-file`, `unsafe` and `invalid-record` do not
      // change on a retry. A `write-failed` code is a disk error. A retry
      // makes a new model call, so it is final too (cost safety).
      return "final"
    case "exception":
      return classifyThrown(input.error)
    case "result": {
      if (ABORT_STOPS.has(input.stopReason)) return "transient"
      const reason = input.reason ?? ""
      if (ABORT_STOPS.has(reason)) return "transient"
      const detail = input.detail ?? ""
      if (reason === "transport") return classifyText(detail)
      // The auth step can refresh a token over the network.
      if (reason === "auth") {
        return detail !== "" && TRANSIENT_TEXT.test(detail) && !BILLING_TEXT.test(detail)
          ? "transient"
          : "final"
      }
      return "final"
    }
    default:
      return "final"
  }
}
