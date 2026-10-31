/**
 * OpenAI wire errors map to the host's error classes (spec S49).
 *
 * The non-2xx mapper is the adapter's one wire-error seam: status, the body
 * error code, and `Retry-After` become the class the host loop decides
 * from (transient, recoverable, permanent).
 *
 * @module adapter.error-class.test
 */

import { describe, expect, it } from "bun:test"

import { taggedHttpError } from "./adapter.ts"

const LABEL = "OpenAI Responses API"
const body = (code: string): string => JSON.stringify({ error: { code, message: "m" } })
const noHeaders = new Headers()

describe("OpenAI wire errors to error classes", () => {
  it("429 is transient, and Retry-After becomes the wait", () => {
    const err = taggedHttpError(
      LABEL,
      429,
      body("rate_limit_exceeded"),
      new Headers({ "retry-after": "7" }),
    )
    expect(err).toMatchObject({
      errorClass: "transient",
      streamErrorType: "rate_limit_error",
      retryAfterMs: 7_000,
    })
  })

  it("5xx and 408 are transient", () => {
    for (const status of [500, 502, 503, 408]) {
      expect(taggedHttpError(LABEL, status, body("server_error"), noHeaders).errorClass).toBe(
        "transient",
      )
    }
  })

  it("401 is recoverable: refresh the credential", () => {
    expect(taggedHttpError(LABEL, 401, body("invalid_api_key"), noHeaders)).toMatchObject({
      errorClass: "recoverable",
      recovery: "refresh_credential",
    })
  })

  it("a context overflow is recoverable: compact", () => {
    expect(taggedHttpError(LABEL, 400, body("context_length_exceeded"), noHeaders)).toMatchObject({
      errorClass: "recoverable",
      recovery: "compact",
    })
  })

  it("billing, 400, 403, and 404 are permanent", () => {
    expect(taggedHttpError(LABEL, 429, body("insufficient_quota"), noHeaders).errorClass).toBe(
      "permanent",
    )
    for (const status of [400, 403, 404]) {
      expect(
        taggedHttpError(LABEL, status, body("invalid_request_error"), noHeaders).errorClass,
      ).toBe("permanent")
    }
  })
})
