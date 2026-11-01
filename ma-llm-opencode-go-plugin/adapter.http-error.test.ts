/**
 * Non-2xx classification for the triple-surface gateway: every pre-stream
 * `!response.ok` throw MUST carry the retry tag the provider-neutral retry
 * coordinator keys on (429 -\> `rate_limit_error` SLOW curve, 5xx -\>
 * `overloaded_error` FAST curve). Billing stays terminal.
 *
 * @module llm/providers/opencode/adapter.http-error.test
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { bootstrapOpencode, opencodeAdapter } from "./adapter.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapOpencode({ models: reg.models, providers: reg.providers })
}

const req: CanonicalRequest = {
  modelId: "deepseek-v4-pro",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}

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
  modelId: string,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<CanonicalEvent[]> {
  const model = reg.resolveModel(modelId) as unknown as ModelEntry
  const ctx: RunContext = {
    auth: { kind: "api-key", key: "og-test-key" },
    sessionId: "s1",
    networkClient: failingClient(status, body, headers),
  }
  const creq = { ...req, modelId }
  return drain(opencodeAdapter.run!(creq, model, ctx))
}

type Tagged = Error & {
  streamErrorType?: string
  errorClass?: string
  recovery?: string
  retryAfterMs?: number
  code?: string
  hint?: string
  opts?: { retryable?: boolean; status?: number }
}

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
    const err = await capture(run("deepseek-v4-pro", 429, body))
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
    const err = await capture(run("deepseek-v4-pro", 400, body))
    expect(err).not.toBeNull()
    expect(err?.streamErrorType).toBeUndefined()
    expect(err?.opts?.retryable).toBe(false)
    expect(err?.code).toBe("opencode.billing")
    expect(err?.hint).toBeTruthy()
  })

  it("treats 402 and Go usage limit codes as terminal billing", async () => {
    setup()
    const e402 = await capture(
      run("deepseek-v4-pro", 402, '{"error":{"message":"Insufficient funds"}}'),
    )
    expect(e402?.code).toBe("opencode.billing")
    expect(e402?.streamErrorType).toBeUndefined()
    const goLimit = await capture(
      run(
        "qwen3.8-max",
        429,
        JSON.stringify({ error: { type: "GoUsageLimitError", message: "limit" } }),
      ),
    )
    expect(goLimit?.code).toBe("opencode.billing")
    expect(goLimit?.streamErrorType).toBeUndefined()
  })

  it("maps 426 and FreeTierError to terminal errors with hints", async () => {
    setup()
    const e426 = await capture(run("deepseek-v4-pro", 426, '{"error":{"type":"UpgradeRequired"}}'))
    expect(e426?.code).toBe("opencode.upgrade_required")
    expect(e426?.hint).toContain("MINIMAL_AGENT_OPENCODE_VERSION")
    const gate = await capture(
      run(
        "deepseek-v4-pro",
        403,
        JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "x" } }),
      ),
    )
    expect(gate?.code).toBe("opencode.free_tier_gate")
    expect(gate?.hint).toBeTruthy()
  })
})

describe("opencode-go auth errors", () => {
  it("adds a re-auth hint to 401 api_key_expired", async () => {
    setup()
    const body = JSON.stringify({
      error: { type: "authentication_error", code: "api_key_expired", message: "expired" },
    })
    const err = await capture(run("deepseek-v4-pro", 401, body))
    expect(err?.code).toBe("opencode.auth")
    expect(err?.hint).toContain("ma provider opencode-go login")
    expect(err?.streamErrorType).toBeUndefined()
  })
})

describe("opencode-go 401 with server_error body", () => {
  it("never retries a 401, even with type server_error", async () => {
    setup()
    const body = JSON.stringify({
      error: { type: "server_error", message: "Upstream request failed: Invalid credential" },
    })
    const err = await capture(run("deepseek-v4-pro", 401, body))
    expect(err?.streamErrorType).toBeUndefined()
    expect(err?.code).toBe("opencode.auth")
    expect(err?.hint).toContain("ma provider opencode-go login")
  })
})

// Spec S49: each known wire error maps to an error class.
describe("opencode-go wire errors to error classes", () => {
  const wire = (code: string) => JSON.stringify({ error: { code, message: "m" } })

  it("maps rate limits and overloads to transient, with Retry-After", async () => {
    setup()
    const limited = await capture(
      run("deepseek-v4-pro", 429, wire("rate_limit_error"), { "retry-after": "5" }),
    )
    expect(limited).toMatchObject({ errorClass: "transient", retryAfterMs: 5_000 })
    const busy = await capture(run("deepseek-v4-pro", 503, wire("server_error")))
    expect(busy?.errorClass).toBe("transient")
  })

  it("maps 401 to recoverable (refresh the credential)", async () => {
    setup()
    const err = await capture(run("deepseek-v4-pro", 401, wire("api_key_expired")))
    expect(err).toMatchObject({ errorClass: "recoverable", recovery: "refresh_credential" })
  })

  it("maps a context overflow to recoverable (compact)", async () => {
    setup()
    const err = await capture(run("deepseek-v4-pro", 400, wire("context_length_exceeded")))
    expect(err).toMatchObject({ errorClass: "recoverable", recovery: "compact" })
  })

  it("maps billing, the client gates, and bad requests to permanent", async () => {
    setup()
    for (const [status, code] of [
      [402, "insufficient_quota"],
      [426, "upgrade_required"],
      [400, "invalid_request_error"],
      [404, "not_found_error"],
    ] as const) {
      const err = await capture(run("deepseek-v4-pro", status, wire(code)))
      expect(err?.errorClass).toBe("permanent")
    }
  })
})
