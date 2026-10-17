/**
 * Request-body gzip for the Anthropic adapter. No network, no credentials.
 *
 * Covers: threshold (bytes, not chars), round-trip incl. multibyte, header
 * hygiene (no content-length, caller headers untouched), opt-out env, the
 * content-encoding-only fallback (415 / matching 400) vs unrelated 4xx/5xx,
 * the process-wide latch, per-attempt freshness (retry / token refresh
 * re-enter `run()`), and that net-dbg still gets readable JSON.
 *
 * @module llm/providers/anthropic/adapter.gzip.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { _resetGzipRejectedForTest, anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequest, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

let resolveModel: (id: string) => ModelEntry
const auth: ProviderAuth = { kind: "api-key", key: "sk-test" }
const ENC_ERR = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: 'Unsupported Content-Encoding "gzip": send the request body uncompressed.',
  },
})
const OTHER_400 = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "max_tokens must be positive" },
})

beforeEach(() => {
  delete process.env.MINIMAL_AGENT_NO_REQUEST_GZIP
  _resetGzipRejectedForTest()
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
})

function reqWith(text: string): CanonicalRequest {
  return {
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  }
}

function sse(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
      c.close()
    },
  })
}

interface Step {
  status: number
  body?: string
}

function scripted(steps: Step[]): { client: NetworkClient; seen: NetworkRequest[] } {
  const seen: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      seen.push(r)
      const step = steps[Math.min(seen.length - 1, steps.length - 1)] ?? { status: 200 }
      const ok = step.status < 300
      return {
        ok,
        status: step.status,
        headers: new Headers(),
        body: ok ? sse() : null,
        text: async () => step.body ?? "",
      } as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, seen }
}

async function runWith(req: CanonicalRequest, client: NetworkClient): Promise<void> {
  const ctx: RunContext = { auth, sessionId: "s1", networkClient: client }
  const events: CanonicalEvent[] = []
  for await (const ev of anthropicAdapter.run!(req, resolveModel("claude-opus-4-8"), ctx)) {
    events.push(ev)
  }
}

const enc = (r: NetworkRequest | undefined): string | undefined => r?.headers?.["content-encoding"]
const gunzipJson = (r: NetworkRequest): any =>
  JSON.parse(new TextDecoder().decode(Bun.gunzipSync(r.body as Uint8Array)))

describe("anthropic request gzip: happy path", () => {
  it("gzips large bodies and the payload round-trips exactly", async () => {
    const { client, seen } = scripted([{ status: 200 }])
    const text = "hello world ".repeat(2000)
    await runWith(reqWith(text), client)
    const r = seen[0]!
    expect(enc(r)).toBe("gzip")
    expect(r.body instanceof Uint8Array).toBe(true)
    expect(Array.from((r.body as Uint8Array).slice(0, 2))).toEqual([0x1f, 0x8b])
    expect(gunzipJson(r).messages[0].content[0].text).toBe(text)
    expect((r.body as Uint8Array).length).toBeLessThan(2000)
  })

  it("round-trips multibyte text (emoji, CJK, RTL) byte-for-byte", async () => {
    const { client, seen } = scripted([{ status: 200 }])
    const text = "héllo 世界 🙂 مرحبا ".repeat(300)
    await runWith(reqWith(text), client)
    expect(gunzipJson(seen[0]!).messages[0].content[0].text).toBe(text)
  })

  it("does not set content-length and does not mutate the shared headers", async () => {
    const { client, seen } = scripted([{ status: 200 }, { status: 200 }])
    await runWith(reqWith("a".repeat(5000)), client)
    expect(seen[0]!.headers?.["content-length"]).toBeUndefined()
    // content-type must survive and the same header builder output is not reused.
    expect(seen[0]!.headers?.["content-type"]).toBe("application/json")
    await runWith(reqWith("hi"), client)
    expect(enc(seen[1])).toBeUndefined()
  })

  it("sends readable JSON to net-dbg via capture.requestBody", async () => {
    const { client, seen } = scripted([{ status: 200 }])
    await runWith(reqWith("a".repeat(5000)), client)
    const cap = seen[0]!.capture?.requestBody
    expect(typeof cap).toBe("string")
    expect(JSON.parse(cap as string).messages[0].content[0].text).toBe("a".repeat(5000))
  })

  it("compresses a ~5 MB history and still decodes", async () => {
    const { client, seen } = scripted([{ status: 200 }])
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(110_000)
    await runWith(reqWith(text), client)
    const r = seen[0]!
    expect(enc(r)).toBe("gzip")
    expect((r.body as Uint8Array).length).toBeLessThan(text.length / 20)
    expect(gunzipJson(r).messages[0].content[0].text.length).toBe(text.length)
  })
})

describe("anthropic request gzip: threshold and opt-out", () => {
  it("leaves tiny bodies uncompressed", async () => {
    const { client, seen } = scripted([{ status: 200 }])
    await runWith(reqWith("hi"), client)
    expect(enc(seen[0])).toBeUndefined()
    expect(typeof seen[0]!.body).toBe("string")
  })

  it("measures the threshold in BYTES, not characters", async () => {
    // 400 three-byte chars = 1200 bytes of text (>1 KB with JSON overhead) but only 400 chars.
    const { client, seen } = scripted([{ status: 200 }])
    await runWith(reqWith("世".repeat(400)), client)
    expect(enc(seen[0])).toBe("gzip")
  })

  it("honors MINIMAL_AGENT_NO_REQUEST_GZIP=1", async () => {
    process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = "1"
    const { client, seen } = scripted([{ status: 200 }])
    await runWith(reqWith("x".repeat(5000)), client)
    expect(enc(seen[0])).toBeUndefined()
    expect(typeof seen[0]!.body).toBe("string")
  })

  it("only an exact '1' disables it (0 / empty keep gzip on)", async () => {
    for (const v of ["0", "", "false"]) {
      process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = v
      const { client, seen } = scripted([{ status: 200 }])
      await runWith(reqWith("x".repeat(5000)), client)
      expect(enc(seen[0])).toBe("gzip")
    }
  })
})

describe("anthropic request gzip: fallback and latch", () => {
  it("retries once uncompressed on 415 with an identical logical body, then stays off", async () => {
    const { client, seen } = scripted([{ status: 415, body: "x" }, { status: 200 }])
    await runWith(reqWith("y".repeat(5000)), client)
    expect(seen.length).toBe(2)
    expect(enc(seen[0])).toBe("gzip")
    expect(enc(seen[1])).toBeUndefined()
    expect(typeof seen[1]!.body).toBe("string")
    expect(JSON.parse(seen[1]!.body as string)).toEqual(gunzipJson(seen[0]!))

    const next = scripted([{ status: 200 }])
    await runWith(reqWith("y".repeat(5000)), next.client)
    expect(enc(next.seen[0])).toBeUndefined()
  })

  it("treats a 400 that names Content-Encoding as a gzip rejection", async () => {
    const { client, seen } = scripted([{ status: 400, body: ENC_ERR }, { status: 200 }])
    await runWith(reqWith("z".repeat(5000)), client)
    expect(seen.length).toBe(2)
    expect(enc(seen[1])).toBeUndefined()
  })

  it("does NOT latch off on an unrelated 400; it surfaces the error once", async () => {
    const { client, seen } = scripted([{ status: 400, body: OTHER_400 }])
    const err = await runWith(reqWith("z".repeat(5000)), client).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toContain("400")
    expect(seen.length).toBe(1)
    const next = scripted([{ status: 200 }])
    await runWith(reqWith("z".repeat(5000)), next.client)
    expect(enc(next.seen[0])).toBe("gzip")
  })

  it("leaves gzip on after 401 / 429 / 500 / 529 (handled by upper layers)", async () => {
    for (const status of [401, 429, 500, 529]) {
      const { client, seen } = scripted([{ status, body: "{}" }])
      await runWith(reqWith("q".repeat(5000)), client).catch(() => undefined)
      expect(seen.length).toBe(1)
      expect(enc(seen[0])).toBe("gzip")
    }
    const next = scripted([{ status: 200 }])
    await runWith(reqWith("q".repeat(5000)), next.client)
    expect(enc(next.seen[0])).toBe("gzip")
  })

  it("re-entry after a failed attempt (retry / 401 refresh) builds a fresh gzipped body", async () => {
    const first = scripted([{ status: 401, body: "{}" }])
    await runWith(reqWith("r".repeat(5000)), first.client).catch(() => undefined)
    const second = scripted([{ status: 200 }])
    await runWith(reqWith("r".repeat(5000)), second.client)
    expect(enc(second.seen[0])).toBe("gzip")
    expect(gunzipJson(second.seen[0]!).messages[0].content[0].text).toBe("r".repeat(5000))
  })

  it("passes the abort signal through on both the gzip and fallback attempts", async () => {
    const ac = new AbortController()
    const { client, seen } = scripted([{ status: 415, body: "x" }, { status: 200 }])
    await runWith({ ...reqWith("s".repeat(5000)), signal: ac.signal }, client)
    expect(seen[0]!.signal).toBe(ac.signal)
    expect(seen[1]!.signal).toBe(ac.signal)
  })
})
