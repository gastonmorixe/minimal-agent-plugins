/**
 * Cursor wire errors mapped to the host's error classes.
 *
 * Cursor speaks Connect over HTTP/2. A failed run ends with a non-2xx HTTP
 * status, or with a Connect end-stream error that names a Connect code
 * (`unavailable`, `unauthenticated`, ...). Both map to an `ErrorClass` here,
 * so the host loop decides from the class and never from Cursor strings.
 *
 * @module error-class
 */

import {
  classifyUpstreamError,
  type ErrorClass,
  type ErrorClassFields,
  type RecoveryAction,
  tagUpstreamError,
} from "@minimal-agent/core/plugin-api/llm/errors"

/** Connect codes that clear on their own: retry with backoff. */
const TRANSIENT_CONNECT_CODES: ReadonlySet<string> = new Set([
  "unavailable",
  "deadline_exceeded",
  "aborted",
  "internal",
  "resource_exhausted",
])

/** Class of a Connect end-stream error code. */
export function classifyConnectCode(code: string | undefined): {
  errorClass: ErrorClass
  recovery?: RecoveryAction
  retryable: boolean
} {
  const c = code?.toLowerCase()
  if (c !== undefined && TRANSIENT_CONNECT_CODES.has(c)) {
    return { errorClass: "transient", retryable: true }
  }
  if (c === "unauthenticated") {
    return { errorClass: "recoverable", recovery: "refresh_credential", retryable: false }
  }
  // invalid_argument, not_found, permission_denied, failed_precondition,
  // unimplemented, unknown, and any code Cursor adds later.
  return { errorClass: "permanent", retryable: false }
}

/** An end-stream error's cause, with the class stamped on it. */
export function connectEndStreamCause(
  code: string | undefined,
  message: string,
): Error & ErrorClassFields {
  return tagUpstreamError(new Error(message), classifyConnectCode(code))
}

/** The error for a non-2xx `AgentService/Run` response. */
export function cursorHttpError(
  status: number,
  headers?: { get(name: string): string | null } | null,
): Error & ErrorClassFields {
  return tagUpstreamError(
    new Error(`cursor AgentService/Run failed (${status})`),
    classifyUpstreamError({ httpStatus: status, retryAfter: headers?.get("retry-after") ?? null }),
  )
}
