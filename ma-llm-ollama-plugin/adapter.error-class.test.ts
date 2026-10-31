/**
 * Ollama Cloud wire errors map to the host's error classes (spec S49).
 *
 * The non-2xx mapper is the adapter's one wire-error seam: status, the body
 * error code, and `Retry-After` become the class the host loop decides
 * from (transient, recoverable, permanent).
 *
 * @module adapter.error-class.test
 */

import { describe, expect, it } from "bun:test"

import { taggedHttpError } from "./adapter.ts"

const body = (code: string): string => JSON.stringify({ error: code })
const noHeaders = new Headers()

describe("Ollama Cloud wire errors to error classes", () => {
  it("429 is transient, and Retry-After becomes the wait", () => {
    const err = taggedHttpError(429, body("rate limited"), new Headers({ "retry-after": "7" }))
    expect(err).toMatchObject({
      errorClass: "transient",
      streamErrorType: "rate_limit_error",
      retryAfterMs: 7_000,
    })
  })

  it("5xx and 408 are transient", () => {
    for (const status of [500, 502, 503, 408]) {
      expect(taggedHttpError(status, body("upstream failed"), noHeaders).errorClass).toBe(
        "transient",
      )
    }
  })

  it("401 is recoverable: refresh the credential", () => {
    expect(taggedHttpError(401, body("unauthorized"), noHeaders)).toMatchObject({
      errorClass: "recoverable",
      recovery: "refresh_credential",
    })
  })

  it("a context overflow is recoverable: compact", () => {
    expect(taggedHttpError(400, body("context_length_exceeded"), noHeaders)).toMatchObject({
      errorClass: "recoverable",
      recovery: "compact",
    })
  })

  it("billing, 400, 403, and 404 are permanent", () => {
    expect(taggedHttpError(402, body("insufficient_quota"), noHeaders).errorClass).toBe("permanent")
    for (const status of [400, 403, 404]) {
      expect(taggedHttpError(status, body("bad request"), noHeaders).errorClass).toBe("permanent")
    }
  })
})
