/**
 * Tests of the Google error body parser and the host class mapping.
 *
 * The 429 fixture is the shape the backend returns for a spent quota; the
 * retry advice is `google.rpc.RetryInfo.retryDelay`, not a `Retry-After`
 * header.
 *
 * @module error-class.test
 */

import { readFileSync } from "node:fs"

import { describe, expect, it } from "bun:test"

import {
  classifyStreamError,
  parseGoogleDuration,
  parseGoogleError,
  taggedAntigravityError,
} from "./error-class.ts"

const quotaBody = readFileSync(`${import.meta.dir}/__fixtures__/stream-error-429.json`, "utf8")

describe("parseGoogleError", () => {
  it("reads the code, the gRPC status, the message and the retry delay", () => {
    expect(parseGoogleError(quotaBody)).toEqual({
      status: 429,
      code: "RESOURCE_EXHAUSTED",
      message: "You have exhausted your capacity on this model. Your quota will reset after 30s.",
      retryAfter: "30s",
      retryDelayMs: 30_000,
    })
  })

  it("returns an empty object for a non-JSON body", () => {
    expect(parseGoogleError("<html>bad gateway</html>")).toEqual({})
  })

  it("reads a top-level status object with no error envelope", () => {
    const body = JSON.stringify({ code: 401, status: "UNAUTHENTICATED", message: "nope" })
    expect(parseGoogleError(body)).toEqual({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "nope",
    })
  })

  it("accepts a numeric code as a string", () => {
    const body = JSON.stringify({ error: { code: "503", status: "UNAVAILABLE" } })
    expect(parseGoogleError(body).status).toBe(503)
  })
})

describe("parseGoogleDuration", () => {
  it("parses whole and fractional seconds", () => {
    expect(parseGoogleDuration("30s")).toBe(30_000)
    expect(parseGoogleDuration("1.5s")).toBe(1_500)
  })

  it("rejects a duration with no unit", () => {
    expect(parseGoogleDuration("30")).toBeUndefined()
    expect(parseGoogleDuration(undefined)).toBeUndefined()
  })
})

describe("taggedAntigravityError", () => {
  it("keeps the status in the message, so the host 401 check finds it", () => {
    const err = taggedAntigravityError(
      401,
      JSON.stringify({ error: { status: "UNAUTHENTICATED" } }),
    )
    expect(err.message).toContain("401")
    expect(err.errorClass).toBe("recoverable")
    expect(err.recovery).toBe("refresh_credential")
  })

  it("maps a spent quota to a transient wait from RetryInfo", () => {
    const err = taggedAntigravityError(429, quotaBody)
    expect(err.errorClass).toBe("transient")
    expect(err.retryAfterMs).toBe(30_000)
  })

  it("maps 5xx to transient and 400 to permanent", () => {
    expect(taggedAntigravityError(503, "{}").errorClass).toBe("transient")
    expect(taggedAntigravityError(400, "{}").errorClass).toBe("permanent")
  })

  it("marks a too-long prompt as a context overflow", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "The input token count (1200000) exceeds the maximum",
      },
    })
    expect(taggedAntigravityError(400, body).recovery).toBe("compact")
  })

  it("prefers a Retry-After header over a missing RetryInfo", () => {
    const headers = { get: (n: string) => (n.toLowerCase() === "retry-after" ? "7" : null) }
    expect(taggedAntigravityError(429, "{}", headers).retryAfterMs).toBe(7_000)
  })
})

describe("classifyStreamError", () => {
  it("maps a quota error to rate_limit and names the gRPC status", () => {
    const err = taggedAntigravityError(429, quotaBody)
    const event = classifyStreamError(err)
    expect(event).toMatchObject({
      type: "stream_error",
      retryable: true,
      category: "rate_limit",
      upstreamType: "RESOURCE_EXHAUSTED",
    })
  })

  it("treats an overloaded backend as retryable", () => {
    const event = classifyStreamError(new Error("Google Antigravity API 503 UNAVAILABLE"))
    expect(event).toMatchObject({ retryable: true, category: "overloaded" })
  })

  it("treats an unknown thrown value as a retryable api error", () => {
    const event = classifyStreamError(new Error("socket closed"))
    expect(event).toMatchObject({ retryable: false, category: "api" })
    expect(event.cause).toBeInstanceOf(Error)
  })

  it("classifies a stream abort as a timeout when the message says so", () => {
    const event = classifyStreamError(new Error("DEADLINE_EXCEEDED 504"))
    expect(event.category).toBe("timeout")
    expect(event.retryable).toBe(true)
  })
})
