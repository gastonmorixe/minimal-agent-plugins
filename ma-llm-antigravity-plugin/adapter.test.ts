/**
 * The tool-signature cache.
 *
 * A Gemini tool loop fails with 400 when the latest assistant `functionCall`
 * has no `thoughtSignature` (live probe, 2026-11-25). Core strips thinking
 * blocks from every assistant message except the last, so a signature carried
 * on a thinking block does not survive a tool round trip. This cache is the
 * source that does.
 *
 * The test drives the real adapter with a fake network client, so it proves
 * the wiring (body in, sink out) and not only the map.
 */
import { beforeEach, describe, expect, test } from "bun:test"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import {
  antigravityAdapter,
  buildRequestId,
  clearAntigravityAdapterState,
  getToolSignature,
  numericSessionId,
  refreshIfExpiring,
  rememberToolSignature,
} from "./adapter.ts"
import { antigravitySecretsToBag, clearTokenExpiry, REFRESH_SKEW_MS } from "./auth.ts"
import { clearAntigravityLiveModelsCache } from "./live-models.ts"
import { findAntigravityModel } from "./models.ts"
import { antigravityOAuthLogin } from "./oauth-login.ts"

const MODEL = findAntigravityModel("gemini-4-neon-high")
if (!MODEL) throw new Error("test fixture: gemini-4-neon-high must be in the catalog")

/** One SSE frame with a signed function call. */
const SIGNED_CALL = `data: ${JSON.stringify({
  response: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { id: "call_7", name: "Read", args: { path: "a.txt" } },
              thoughtSignature: "SIG-ABC",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    modelVersion: "gemini-4-neon-high",
    responseId: "resp-1",
  },
})}\r\n\r\n`

/** A network client that records the calls and answers a scripted response. */
function fakeNetwork(bodies: string[]) {
  const requests: Array<{ url: string; body?: string; headers?: Record<string, string> }> = []
  return {
    requests,
    client: {
      async request(opts: {
        url: string
        body?: string
        headers?: Record<string, string>
      }): Promise<Response> {
        requests.push({ url: opts.url, body: opts.body, headers: opts.headers })
        if (opts.url.includes("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        const body = bodies.shift() ?? ""
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      },
    },
  }
}

/** A canonical request with one user turn. */
function request(messages: CanonicalRequest["messages"]): CanonicalRequest {
  return {
    modelId: "gemini-4-neon-high",
    messages,
    generation: { maxOutputTokens: 256 },
  } as CanonicalRequest
}

/** Drain the adapter stream and keep the event types. */
async function drain(req: CanonicalRequest, client: unknown): Promise<string[]> {
  const events: string[] = []
  for await (const ev of antigravityAdapter.run(
    req,
    MODEL as never,
    {
      auth: { kind: "oauth", token: "tok" },
      sessionId: "sess-1",
      networkClient: client,
    } as never,
  )) {
    events.push(ev.type)
  }
  return events
}

beforeEach(() => {
  clearAntigravityAdapterState()
  clearAntigravityLiveModelsCache()
})

describe("signature cache", () => {
  test("stores a signature by tool call id", () => {
    rememberToolSignature("call_1", "SIG-1")
    expect(getToolSignature("call_1")).toBe("SIG-1")
  })

  test("ignores an empty id or an empty signature", () => {
    rememberToolSignature("", "SIG")
    rememberToolSignature("call_2", "")
    expect(getToolSignature("call_2")).toBeUndefined()
  })

  test("keeps the newest 512 entries and drops the oldest", () => {
    for (let i = 0; i < 513; i++) rememberToolSignature(`call_${i}`, `SIG-${i}`)
    expect(getToolSignature("call_0")).toBeUndefined()
    expect(getToolSignature("call_512")).toBe("SIG-512")
  })
})

describe("adapter wiring of the signature cache", () => {
  test("a streamed signed function call fills the cache", async () => {
    const net = fakeNetwork([SIGNED_CALL])
    const events = await drain(
      request([{ role: "user", content: [{ type: "text", text: "read a.txt" }] }]),
      net.client,
    )
    expect(events).toContain("tool_use_start")
    expect(getToolSignature("call_7")).toBe("SIG-ABC")
  })

  test("the next turn sends the cached signature on the functionCall part", async () => {
    const net = fakeNetwork([SIGNED_CALL, "data: {}\r\n\r\n"])
    await drain(
      request([{ role: "user", content: [{ type: "text", text: "read a.txt" }] }]),
      net.client,
    )

    const history: CanonicalRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "read a.txt" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_7", name: "Read", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_7", content: [{ type: "text", text: "hello" }] },
        ],
      },
    ]
    await drain(request(history), net.client)

    // The second call is the tool-loop turn; the first is the bootstrap-free start.
    const streams = net.requests.filter((r) => r.url.includes("streamGenerateContent"))
    expect(streams.length).toBe(2)
    const sent = JSON.parse(streams[1]?.body ?? "{}") as {
      request?: { contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
    }
    const modelTurn = sent.request?.contents?.find((c) => c.role === "model")
    const call = modelTurn?.parts.find((p) => "functionCall" in p)
    expect(call?.thoughtSignature).toBe("SIG-ABC")
  })

  // Regression, session 51282a5c (2026-11-27): a completion digest that the
  // host queued during a tool round never reached the model. See
  // research/2026-11-27-lost-subagent-digest/REPORT.md.
  test("the tool-loop turn sends the queued text that follows the tool result", async () => {
    const net = fakeNetwork(["data: {}\r\n\r\n"])
    const history: CanonicalRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "read a.txt" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_9", name: "Read", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_9", content: [{ type: "text", text: "hello" }] },
          { type: "text", text: "Sub-agent A2 (audit-prompts-tokens) finished" },
        ],
      },
    ]
    await drain(request(history), net.client)

    const stream = net.requests.find((r) => r.url.includes("streamGenerateContent"))
    const sent = JSON.parse(stream?.body ?? "{}") as {
      request?: { contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
    }
    const tail = sent.request?.contents?.at(-1)
    expect(tail?.role).toBe("user")
    expect(tail?.parts.some((p) => "functionResponse" in p)).toBe(true)
    expect(tail?.parts).toContainEqual({ text: "Sub-agent A2 (audit-prompts-tokens) finished" })
  })

  test("every turn carries the agy User-Agent", async () => {
    const net = fakeNetwork([SIGNED_CALL])
    clearAntigravityAdapterState()
    clearAntigravityLiveModelsCache()
    await drain(request([{ role: "user", content: [{ type: "text", text: "hi" }] }]), net.client)
    const stream = net.requests.find((r) => r.url.includes("streamGenerateContent"))
    const ua = stream?.headers?.["user-agent"] ?? ""
    expect(ua).toContain("aidev_client")
  })
})

describe("request locator", () => {
  test("requestId has the agy shape and a numeric conversation id", () => {
    const id = buildRequestId("sess-1", 2)
    expect(id).toMatch(/^agent\/\d+\/\d+\/2\/0$/)
  })

  test("numericSessionId gives digits only, and never an empty string", () => {
    expect(numericSessionId("abc")).toMatch(/^\d+$/)
    expect(numericSessionId("")).toMatch(/^\d+$/)
  })
})

describe("proactive token refresh", () => {
  /** Auth of a credential that the host read through `readAuth`. */
  function storedAuth(expiresAt: number, refresh: () => Promise<{ token: string }>) {
    const auth = antigravityOAuthLogin.readAuth?.(
      antigravitySecretsToBag({
        tokenType: "oauth",
        accessToken: `old-${expiresAt}`,
        refreshToken: "refresh",
        expiresAt,
      }),
    )
    if (auth?.kind !== "oauth") throw new Error("test fixture: readAuth must give an oauth auth")
    return { ...auth, refresh }
  }

  beforeEach(() => clearTokenExpiry())

  test("a token inside the refresh window is refreshed before the stream call", async () => {
    let calls = 0
    const auth = storedAuth(Date.now() + REFRESH_SKEW_MS - 1_000, async () => {
      calls += 1
      return { token: "fresh" }
    })
    const { client, requests } = fakeNetwork([SIGNED_CALL])
    for await (const _ of antigravityAdapter.run(
      request([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
      MODEL as never,
      { auth, sessionId: "sess-r", networkClient: client } as never,
    )) {
      // drain
    }
    expect(calls).toBe(1)
    expect(auth.token).toBe("fresh")
    const stream = requests.find((r) => r.url.includes("streamGenerateContent"))
    expect(stream?.headers?.authorization).toBe("Bearer fresh")
  })

  test("a token outside the refresh window is not refreshed", async () => {
    let calls = 0
    const auth = storedAuth(Date.now() + 30 * 60_000, async () => {
      calls += 1
      return { token: "fresh" }
    })
    const old = auth.token
    await refreshIfExpiring(auth)
    expect(calls).toBe(0)
    expect(auth.token).toBe(old)
  })

  test("two turns with the same expiring token share one refresh", async () => {
    let calls = 0
    const refresh = async () => {
      calls += 1
      await Bun.sleep(5)
      return { token: "fresh" }
    }
    const expiresAt = Date.now() - 1_000
    const a = storedAuth(expiresAt, refresh)
    const b = storedAuth(expiresAt, refresh)
    await Promise.all([refreshIfExpiring(a), refreshIfExpiring(b)])
    expect(calls).toBe(1)
    expect(a.token).toBe("fresh")
    expect(b.token).toBe("fresh")
  })

  test("a failed refresh keeps the old token, and the host 401 path makes the last attempt", async () => {
    const auth = storedAuth(Date.now() - 1_000, async () => {
      throw new Error("invalid_grant")
    })
    const old = auth.token
    await refreshIfExpiring(auth)
    expect(auth.token).toBe(old)
  })

  test("an auth with no refresh callback is left as is", async () => {
    const auth = { kind: "oauth" as const, token: "tok" }
    await refreshIfExpiring(auth)
    expect(auth.token).toBe("tok")
  })
})
