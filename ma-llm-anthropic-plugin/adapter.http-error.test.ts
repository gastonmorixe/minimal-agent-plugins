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

import { anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequest, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
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

function failingClient(status: number, body: string): NetworkClient {
  return {
    request: async (_req: NetworkRequest): Promise<NetworkResponse> =>
      ({
        ok: false,
        status,
        headers: new Headers(),
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

function run(status: number, body: string): Promise<CanonicalEvent[]> {
  const ctx: RunContext = { auth, sessionId: "s1", networkClient: failingClient(status, body) }
  return drain(anthropicAdapter.run!(req, resolveModel("claude-opus-4-8"), ctx))
}

type Tagged = Error & { streamErrorType?: string; retryable?: boolean }

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
})
