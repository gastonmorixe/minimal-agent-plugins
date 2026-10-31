/**
 * Non-2xx classification: the adapter's pre-stream `!response.ok` throw MUST
 * carry the retry tag the provider-neutral retry coordinator keys on.
 *
 * Regression: a 429 `rate_limit_error` threw a raw `Anthropic API 429: ...`
 * Error with no `streamErrorType`, so it surfaced to the user instead of
 * entering the SLOW retry curve. Billing codes stay terminal
 * (`retryable: false`).
 *
 * @module llm/providers/anthropic/adapter.http-error.test
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

let resolveModel: (id: string) => ModelEntry
function setup() {
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
}

const req: CanonicalRequest = {
  modelId: "claude-opus-4-8",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}

const auth: ProviderAuth = { kind: "api-key", key: "sk-test" }

function failingClient(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): NetworkClient {
  return {
    request: async (_req: NetworkRequest): Promise<NetworkResponse> =>
      ({
        ok: false,
        status,
        headers: new Headers(headers),
        body: null,
        text: async () => body,
        json: async <T>() => JSON.parse(body) as T,
      }) as unknown as NetworkResponse,
  } as NetworkClient
}

async function drain(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

function run(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<CanonicalEvent[]> {
  const ctx: RunContext = {
    auth,
    sessionId: "s1",
    networkClient: failingClient(status, body, headers),
  }
  return drain(anthropicAdapter.run!(req, resolveModel("claude-opus-4-8"), ctx))
}

type Tagged = Error & {
  streamErrorType?: string
  retryable?: boolean
  errorClass?: string
  recovery?: string
  retryAfterMs?: number
  resetAt?: number
}

/** Run one failing request and return the thrown error. */
async function thrown(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<Tagged> {
  setup()
  const err = await run(status, body, headers).then(
    () => null,
    (e: unknown) => e as Tagged,
  )
  if (!err) throw new Error("expected the run to throw")
  return err
}

const wire = (type: string, message = "m"): string =>
  JSON.stringify({ type: "error", error: { type, message } })

describe("anthropicAdapter.run non-2xx classification", () => {
  it("tags 429 rate_limit_error for the SLOW retry curve", async () => {
    setup()
    const body = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limit reached" },
    })
    const err = (await run(429, body).then(
      () => null,
      (e: unknown) => e,
    )) as Tagged | null
    expect(err).not.toBeNull()
    expect(err?.message).toContain("Anthropic API 429")
    expect(err?.streamErrorType).toBe("rate_limit_error")
    expect(err?.retryable).toBeUndefined()
  })

  it("tags 529 overload_error for the FAST retry curve", async () => {
    setup()
    const body = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    })
    const err = (await run(529, body).then(
      () => null,
      (e: unknown) => e,
    )) as Tagged | null
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBe("overloaded_error")
  })

  it("leaves billing exhaustion terminal (retryable false, untagged)", async () => {
    setup()
    const body = JSON.stringify({
      type: "error",
      error: { type: "insufficient_quota", message: "Out of quota" },
    })
    const err = (await run(400, body).then(
      () => null,
      (e: unknown) => e,
    )) as Tagged | null
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBeUndefined()
    expect(err?.retryable).toBe(false)
  })

  it("classifies bare 429 by status when the body is not JSON", async () => {
    setup()
    const err = (await run(429, "too many requests").then(
      () => null,
      (e: unknown) => e,
    )) as Tagged | null
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBe("rate_limit_error")
  })

  // Spec S49: each known wire error maps to an error class.
  it("maps known wire errors to error classes", async () => {
    expect(await thrown(429, wire("rate_limit_error"), { "retry-after": "9" })).toMatchObject({
      errorClass: "transient",
      retryAfterMs: 9_000,
    })
    expect((await thrown(529, wire("overloaded_error"))).errorClass).toBe("transient")
    expect((await thrown(500, wire("api_error"))).errorClass).toBe("transient")
    expect(await thrown(401, wire("authentication_error"))).toMatchObject({
      errorClass: "recoverable",
      recovery: "refresh_credential",
    })
    expect(
      await thrown(400, wire("invalid_request_error", "prompt is too long: 210000 tokens")),
    ).toMatchObject({ errorClass: "recoverable", recovery: "compact" })
    expect(await thrown(413, wire("request_too_large"))).toMatchObject({ recovery: "compact" })
    expect((await thrown(400, wire("invalid_request_error"))).errorClass).toBe("permanent")
    expect((await thrown(404, wire("not_found_error"))).errorClass).toBe("permanent")
    expect((await thrown(403, wire("permission_error"))).errorClass).toBe("permanent")
    expect((await thrown(400, wire("insufficient_quota"))).errorClass).toBe("permanent")
  })

  it("maps a rejected plan quota with a reset time to a quota wait", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600
    const err = await thrown(429, wire("rate_limit_error"), {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(resetSec),
    })
    expect(err).toMatchObject({
      errorClass: "recoverable",
      recovery: "wait_for_quota",
      resetAt: resetSec * 1000,
    })
  })
})
