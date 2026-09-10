/**
 * Non-2xx classification for the triple-surface gateway: every pre-stream
 * `!response.ok` throw MUST carry the retry tag the provider-neutral retry
 * coordinator keys on (429 -> `rate_limit_error` SLOW curve, 5xx ->
 * `overloaded_error` FAST curve). Billing stays terminal.
 *
 * @module llm/providers/opencode/adapter.http-error.test
 */

import { describe, expect, it } from "bun:test"

import { bootstrapOpencode, opencodeAdapter } from "./adapter.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequest, NetworkResponse } from "./lib/net-types.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapOpencode({ models: reg.models, providers: reg.providers })
}

const req: CanonicalRequest = {
  modelId: "deepseek-v4-flash",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}

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

function run(modelId: string, status: number, body: string): Promise<CanonicalEvent[]> {
  const model = reg.resolveModel(modelId) as unknown as ModelEntry
  const ctx: RunContext = {
    auth: { kind: "api-key", key: "og-test-key" },
    sessionId: "s1",
    networkClient: failingClient(status, body),
  }
  const creq = { ...req, modelId }
  return drain(opencodeAdapter.run!(creq, model, ctx))
}

type Tagged = Error & { streamErrorType?: string; retryable?: boolean }

async function capture(p: Promise<CanonicalEvent[]>): Promise<Tagged | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Tagged,
  )
}

describe("opencodeAdapter.run non-2xx classification", () => {
  it("tags 429 rate_limit_error on the chat surface", async () => {
    setup()
    const body = JSON.stringify({ error: { code: "rate_limit_error", message: "slow down" } })
    const err = await capture(run("deepseek-v4-flash", 429, body))
    expect(err).not.toBeNull()
    expect(err?.message).toContain("OpenCode Go API 429")
    expect(err?.streamErrorType).toBe("rate_limit_error")
  })

  it("tags 429 rate_limit_error on the anthropic-messages surface", async () => {
    setup()
    const body = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    })
    const err = await capture(run("qwen3.8-max", 429, body))
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBe("rate_limit_error")
  })

  it("tags 503 overload on the responses surface", async () => {
    setup()
    const body = JSON.stringify({ error: { code: "server_error", message: "busy" } })
    const err = await capture(run("gpt-5.6-luna", 503, body))
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBe("overloaded_error")
  })

  it("leaves billing exhaustion terminal (retryable false, untagged)", async () => {
    setup()
    const body = JSON.stringify({ error: { code: "insufficient_quota", message: "broke" } })
    const err = await capture(run("deepseek-v4-flash", 400, body))
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBeUndefined()
    expect(err?.retryable).toBe(false)
  })
})
