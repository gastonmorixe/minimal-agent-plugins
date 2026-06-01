/**
 * Fetch failure taxonomy + operator-only trace logging.
 *
 * Two jobs:
 *
 *   1. Turn an opaque backend failure (exit code + stderr) into a typed,
 *      **backend-agnostic** `FetchError` whose `message` is always safe to
 *      hand the model. No raw stderr, no engine identity, ever.
 *
 *   2. For failures we cannot classify, persist the full raw detail (incl.
 *      stderr, exit code, the backend that ran) to an operator-only trace
 *      file and hand back a short opaque `traceId`. The on-disk PATH is
 *      never returned and must never reach a model-facing string: a model
 *      told about a readable file will try to read it. Operators find the
 *      directory via the plugin README, not via the tool output.
 *
 * The Fetch tool is backend-agnostic by contract. This module is the
 * choke point that keeps engine-specific text from leaking out through the
 * one place it otherwise could: diagnostics on a failed fetch.
 *
 * @module lib/errors
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Backend-agnostic failure taxonomy. */
export type FetchErrorKind =
  | "timeout" // navigation/idle deadline exceeded
  | "http" // server returned a 4xx/5xx
  | "dns" // host could not be resolved
  | "tls" // TLS/SSL/certificate failure
  | "navigation" // connection refused/reset, net::ERR_*, etc.
  | "engine-unavailable" // backend script missing / failed to spawn (misconfig)
  | "aborted" // user/watchdog abort
  | "unknown" // unclassified non-zero exit → gets a trace log

/**
 * A typed Fetch failure.
 *
 * `message` is always backend-agnostic and safe to surface to the model.
 * `traceId` (when set) is an opaque correlation handle for an operator-only
 * trace file. The trace's filesystem path is intentionally NOT carried on
 * the error and must never be rendered into a `tool_result`.
 */
export class FetchError extends Error {
  readonly kind: FetchErrorKind
  readonly exitCode?: number
  readonly traceId?: string

  constructor(
    kind: FetchErrorKind,
    message: string,
    opts: { exitCode?: number; traceId?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = "FetchError"
    this.kind = kind
    this.exitCode = opts.exitCode
    this.traceId = opts.traceId
  }
}

/**
 * Directory for operator-only failure traces. Deliberately NOT exported,
 * and never embedded in a model-facing string. Operators learn it from the
 * plugin README's "Failure traces" section.
 */
const TRACE_DIR = join(tmpdir(), "ma-fetch-traces")

/** Generate a short, opaque, path-free correlation id (e.g. `t-lqy3-9f1a2b`). */
export function newTraceId(): string {
  // Fixed 6-hex-digit suffix. `Math.random().toString(16).slice(2,8)` could
  // yield fewer than 6 chars (or "") when the fraction is short or exactly 0,
  // producing a malformed `t-<ts>-` with a dangling dash; this can't degenerate.
  const rand = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, "0")
  return `t-${Date.now().toString(36)}-${rand}`
}

/**
 * Persist a full failure trace for the operator and return its id.
 *
 * Best-effort: NEVER throws (a logging failure must not mask the original
 * fetch failure) and returns `undefined` if the write fails. NEVER returns
 * the path. The caller surfaces only the returned id to the model.
 */
export function writeTraceLog(detail: {
  url: string
  backend: string
  exitCode: number
  stderr: string
  kind: FetchErrorKind
}): string | undefined {
  const traceId = newTraceId()
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
    const body = [
      `trace:    ${traceId}`,
      `time:     ${new Date().toISOString()}`,
      `url:      ${detail.url}`,
      `backend:  ${detail.backend}`,
      `kind:     ${detail.kind}`,
      `exitCode: ${detail.exitCode}`,
      "--- stderr ---",
      detail.stderr.length > 0 ? detail.stderr : "(empty)",
      "",
    ].join("\n")
    writeFileSync(join(TRACE_DIR, `${traceId}.log`), body, { mode: 0o600 })
    return traceId
  } catch {
    return undefined
  }
}

/**
 * Classify a backend failure into a typed, backend-agnostic `FetchError`.
 *
 * Inspects exit code + stderr for well-known signatures. The returned
 * `message` is hand-written and contains NO raw stderr and NO engine
 * identity. Anything unrecognized maps to `kind: "unknown"` with a generic
 * message; the caller is expected to `writeTraceLog` for that case and
 * append the returned id.
 */
export function classifyBackendFailure(opts: { exitCode: number; stderr: string }): FetchError {
  const s = opts.stderr.toLowerCase()
  const ec = opts.exitCode

  if (/timed out|timeout|deadline exceeded/.test(s)) {
    return new FetchError("timeout", "Fetch: the page timed out before it finished loading.", {
      exitCode: ec,
    })
  }

  if (/could not resolve|name resolution|getaddrinfo|enotfound|dns/.test(s)) {
    return new FetchError("dns", "Fetch: the host could not be resolved (DNS failure).", {
      exitCode: ec,
    })
  }

  if (/\btls\b|\bssl\b|certificate|handshake/.test(s)) {
    return new FetchError("tls", "Fetch: the secure connection (TLS) could not be established.", {
      exitCode: ec,
    })
  }

  // HTTP status: a 4xx/5xx mentioned alongside an http-ish token.
  const status = s.match(/\b(4\d\d|5\d\d)\b/)
  if (
    status &&
    /http|status|response|forbidden|not found|unauthorized|gateway|server error/.test(s)
  ) {
    return new FetchError("http", `Fetch: the server responded with HTTP ${status[1]}.`, {
      exitCode: ec,
    })
  }

  if (/connection refused|connection reset|econnrefused|econnreset|net::err|navigation/.test(s)) {
    return new FetchError(
      "navigation",
      "Fetch: the page could not be reached (connection error).",
      {
        exitCode: ec,
      },
    )
  }

  return new FetchError("unknown", "Fetch: the page could not be fetched.", { exitCode: ec })
}
