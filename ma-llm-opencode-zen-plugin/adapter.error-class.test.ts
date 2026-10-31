/**
 * OpenCode Zen wire errors map to the host's error classes (spec S49).
 *
 * @module adapter.error-class.test
 */

import { describe, expect, it } from "bun:test"

import { taggedHttpError } from "./adapter.ts"

const wire = (code: string): string => JSON.stringify({ error: { code, message: "m" } })

describe("OpenCode Zen wire errors to error classes", () => {
  it("429 and 5xx are transient, and Retry-After becomes the wait", () => {
    const err = taggedHttpError(
      429,
      wire("rate_limit_error"),
      {},
      new Headers({ "retry-after": "3" }),
    )
    expect(err).toMatchObject({ errorClass: "transient", retryAfterMs: 3_000 })
    expect(taggedHttpError(503, "Service Unavailable").errorClass).toBe("transient")
  })

  it("401 is recoverable: refresh the credential", () => {
    expect(taggedHttpError(401, wire("api_key_expired"))).toMatchObject({
      errorClass: "recoverable",
      recovery: "refresh_credential",
    })
  })

  it("a context overflow is recoverable: compact", () => {
    expect(taggedHttpError(400, wire("context_length_exceeded"))).toMatchObject({
      errorClass: "recoverable",
      recovery: "compact",
    })
  })

  it("billing, the client gates, and bad requests are permanent", () => {
    expect(taggedHttpError(402, wire("insufficient_quota")).errorClass).toBe("permanent")
    expect(taggedHttpError(400, wire("FreeTierError")).errorClass).toBe("permanent")
    expect(taggedHttpError(426, wire("upgrade_required")).errorClass).toBe("permanent")
    expect(taggedHttpError(404, wire("not_found_error")).errorClass).toBe("permanent")
  })
})
