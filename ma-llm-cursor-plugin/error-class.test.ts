/**
 * Cursor wire errors map to the host's error classes (spec S49): HTTP
 * statuses on `AgentService/Run`, and Connect end-stream error codes.
 *
 * @module error-class.test
 */

import { describe, expect, it } from "bun:test"

import { classifyConnectCode, connectEndStreamCause, cursorHttpError } from "./error-class.ts"

describe("Cursor wire errors to error classes", () => {
  it("maps HTTP statuses, with Retry-After", () => {
    expect(cursorHttpError(429, new Headers({ "retry-after": "2" }))).toMatchObject({
      errorClass: "transient",
      retryAfterMs: 2_000,
    })
    expect(cursorHttpError(503).errorClass).toBe("transient")
    expect(cursorHttpError(401)).toMatchObject({
      errorClass: "recoverable",
      recovery: "refresh_credential",
    })
    expect(cursorHttpError(400).errorClass).toBe("permanent")
    expect(cursorHttpError(404).errorClass).toBe("permanent")
  })

  it("maps Connect end-stream codes", () => {
    for (const code of ["unavailable", "deadline_exceeded", "internal", "resource_exhausted"]) {
      expect(classifyConnectCode(code)).toEqual({ errorClass: "transient", retryable: true })
    }
    expect(classifyConnectCode("unauthenticated")).toMatchObject({
      errorClass: "recoverable",
      recovery: "refresh_credential",
    })
    for (const code of [
      "invalid_argument",
      "permission_denied",
      "not_found",
      "unknown",
      undefined,
    ]) {
      expect(classifyConnectCode(code).errorClass).toBe("permanent")
    }
  })

  it("stamps the class on the end-stream cause the host throws", () => {
    const cause = connectEndStreamCause("UNAVAILABLE", "try again")
    expect(cause.message).toBe("try again")
    expect(cause.errorClass).toBe("transient")
  })
})
