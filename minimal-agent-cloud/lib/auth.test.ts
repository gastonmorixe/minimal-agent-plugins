import { describe, expect, it } from "bun:test"

import { type AuthIo, DEVICE_GRANT_TYPE, pollForToken, requestDeviceCode } from "./auth.ts"

/** A fake fetch that returns scripted responses per call. */
function scriptedIo(responses: Response[]): {
  io: AuthIo
  calls: { url: string; body: unknown }[]
} {
  const calls: { url: string; body: unknown }[] = []
  let i = 0
  const io: AuthIo = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      return r
    }) as unknown as typeof fetch,
    sleep: async () => {}, // no real waiting in tests
    now: (() => {
      let t = 0
      return () => {
        t += 1000
        return t
      }
    })(),
  }
  return { io, calls }
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const CFG = { baseUrl: "http://localhost:4000/api/auth", clientId: "minimal-agent-cli" }

describe("requestDeviceCode", () => {
  it("POSTs client_id and returns the device code", async () => {
    const { io, calls } = scriptedIo([
      json(200, {
        device_code: "dev-123",
        user_code: "WXYZ-1234",
        verification_uri: "http://localhost:4000/device",
        verification_uri_complete: "http://localhost:4000/device?user_code=WXYZ-1234",
        expires_in: 900,
        interval: 5,
      }),
    ])
    const res = await requestDeviceCode(io, CFG)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.user_code).toBe("WXYZ-1234")
      expect(res.value.interval).toBe(5)
    }
    expect(calls[0]?.url).toBe("http://localhost:4000/api/auth/device/code")
    const firstBody = calls[0]?.body as { client_id: string } | undefined
    expect(firstBody?.client_id).toBe("minimal-agent-cli")
  })

  it("returns ok:false on a non-200", async () => {
    const { io } = scriptedIo([json(400, { error: "invalid_client" })])
    const res = await requestDeviceCode(io, CFG)
    expect(res.ok).toBe(false)
  })

  it("returns ok:false on a network throw", async () => {
    const io: AuthIo = {
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
    }
    const res = await requestDeviceCode(io, CFG)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("ECONNREFUSED")
  })
})

describe("pollForToken — RFC 8628 polling state machine", () => {
  const pollOpts = {
    ...CFG,
    deviceCode: "dev-123",
    interval: 1,
    expiresIn: 100,
  }

  it("keeps polling through authorization_pending, then succeeds with the set-auth-token header", async () => {
    const { io, calls } = scriptedIo([
      json(400, { error: "authorization_pending" }),
      json(400, { error: "authorization_pending" }),
      json(
        200,
        { session: { token: "ignored" }, user: { id: "user-1" } },
        { "set-auth-token": "BEARER-XYZ" },
      ),
    ])
    const res = await pollForToken(io, pollOpts)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.accessToken).toBe("BEARER-XYZ")
      expect(res.value.userId).toBe("user-1")
    }
    // sent the grant_type on every poll
    const pollBody = calls[0]?.body as { grant_type: string } | undefined
    expect(pollBody?.grant_type).toBe(DEVICE_GRANT_TYPE)
    expect(calls.length).toBe(3)
  })

  it("falls back to session.token in the body when no header is present", async () => {
    const { io } = scriptedIo([json(200, { session: { token: "BODY-TOKEN", userId: "u9" } })])
    const res = await pollForToken(io, pollOpts)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.accessToken).toBe("BODY-TOKEN")
      expect(res.value.userId).toBe("u9")
    }
  })

  it("handles slow_down by continuing (no failure)", async () => {
    const { io } = scriptedIo([
      json(400, { error: "slow_down" }),
      json(200, {}, { "set-auth-token": "T" }),
    ])
    const res = await pollForToken(io, pollOpts)
    expect(res.ok).toBe(true)
  })

  it("access_denied is a terminal failure", async () => {
    const { io } = scriptedIo([json(400, { error: "access_denied" })])
    const res = await pollForToken(io, pollOpts)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("denied")
  })

  it("expired_token is a terminal failure", async () => {
    const { io } = scriptedIo([json(400, { error: "expired_token" })])
    const res = await pollForToken(io, pollOpts)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("expired")
  })

  it("a 200 with no token at all is an error", async () => {
    const { io } = scriptedIo([json(200, { session: {} })])
    const res = await pollForToken(io, pollOpts)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("no bearer token")
  })
})
