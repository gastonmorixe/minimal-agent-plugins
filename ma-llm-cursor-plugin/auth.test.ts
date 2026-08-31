import { describe, expect, it } from "bun:test"

import {
  buildCursorApiKeyCredential,
  clearCursorExchangeCache,
  cursorApiKeyAuth,
  exchangeCursorApiKey,
  parseCursorTokenPair,
  readCursorApiKey,
} from "./auth.ts"
import { buildCursorHeaders } from "./headers.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import {
  completeCursorLogin,
  createCursorLoginChallenge,
  cursorAccountDetails,
  cursorOAuthLogin,
  cursorPollDelayMs,
  enrichCursorSecrets,
  inspectCursorOAuthCredential,
  refreshCursorOAuthCredential,
} from "./oauth-login.ts"

describe("Cursor API-key auth", () => {
  it("encodes API keys without exposing them through inspection", () => {
    const built = buildCursorApiKeyCredential("cursor-key-secret")
    expect(built.secrets).toEqual({ tokenType: "api-key", apiKey: "cursor-key-secret" })
    expect(readCursorApiKey(built.secrets)).toBe("cursor-key-secret")
    expect(cursorApiKeyAuth.inspectCredential?.(built.secrets)).toEqual({
      usable: true,
      label: "Cursor API Key",
    })
  })

  it("exchanges an API key for a Cursor bearer pair via fetch (not NetworkClient)", async () => {
    let sawAuthorization = ""
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      sawAuthorization = headers.get("authorization") ?? ""
      return new Response(
        JSON.stringify({ accessToken: "access-redacted", refreshToken: "refresh-redacted" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    try {
      // networkClient is ignored for the secret call (must not log Authorization).
      const pair = await exchangeCursorApiKey("api-redacted", {
        networkClient: {
          async request() {
            throw new Error("should not use NetworkClient")
          },
        },
      })
      expect(sawAuthorization).toBe("Bearer api-redacted")
      expect(pair.accessToken).toBe("access-redacted")
      expect(pair.refreshToken).toBe("refresh-redacted")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("rejects incomplete token responses", () => {
    expect(() => parseCursorTokenPair({ accessToken: "only-one" })).toThrow("refreshToken")
  })

  it("caches API-key exchanges until near JWT expiry", async () => {
    clearCursorExchangeCache()
    let calls = 0
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const accessToken = `${header}.${payload}.sig`
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ accessToken, refreshToken: "refresh-redacted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    try {
      const first = await exchangeCursorApiKey("api-redacted")
      const second = await exchangeCursorApiKey("api-redacted")
      expect(calls).toBe(1)
      expect(second.accessToken).toBe(first.accessToken)
      await exchangeCursorApiKey("api-redacted", { force: true })
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = realFetch
      clearCursorExchangeCache()
    }
  })
})

describe("Cursor OAuth refreshCredential", () => {
  it("re-exchanges when the bag still has an API key", async () => {
    clearCursorExchangeCache()
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const accessToken = `${header}.${payload}.sig`
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accessToken, refreshToken: "refresh-new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const built = await refreshCursorOAuthCredential({
        tokenType: "oauth",
        accessToken: "stale",
        refreshToken: "stale-rt",
        apiKey: "api-redacted",
      })
      expect(built.result.accessToken).toBe(accessToken)
      expect(built.credential.secrets.apiKey).toBe("api-redacted")
      expect(cursorOAuthLogin.refreshCredential).toBe(refreshCursorOAuthCredential)
    } finally {
      globalThis.fetch = realFetch
      clearCursorExchangeCache()
    }
  })

  it("fails clearly for browser-login bags without an API key", async () => {
    await expect(
      refreshCursorOAuthCredential({
        tokenType: "oauth",
        accessToken: "stale",
        refreshToken: "rt-only",
      }),
    ).rejects.toThrow(/cannot be refreshed automatically/)
  })

  it("preserves prior account metadata when the enrichment probe fails on refresh", async () => {
    clearCursorExchangeCache()
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const accessToken = `${header}.${payload}.sig`
    const realFetch = globalThis.fetch
    // Exchange succeeds; both enrichment endpoints fail.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : String(url)
      if (href.includes("GetMe") || href.includes("GetCurrentPeriodUsage")) {
        return new Response("{}", { status: 500 })
      }
      return new Response(JSON.stringify({ accessToken, refreshToken: "refresh-new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    try {
      const built = await refreshCursorOAuthCredential({
        tokenType: "oauth",
        accessToken: "stale",
        refreshToken: "stale-rt",
        apiKey: "api-redacted",
        email: "kept@example.com",
        userId: 42,
      })
      expect(built.credential.secrets.email).toBe("kept@example.com")
      expect(built.credential.secrets.userId).toBe(42)
      expect(built.credential.secrets.apiKey).toBe("api-redacted")
    } finally {
      globalThis.fetch = realFetch
      clearCursorExchangeCache()
    }
  })
})

describe("Cursor account metadata projection", () => {
  it("enriches a secrets bag via the wire probes", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : String(url)
      if (href.includes("GetMe")) {
        // field 2 user_id=77, field 3 email
        return new Response(new Uint8Array([0x10, 0x4d, 0x1a, 5, 0x61, 0x40, 0x62, 0x2e, 0x63]), {
          status: 200,
          headers: { "content-type": "application/proto" },
        })
      }
      if (href.includes("GetCurrentPeriodUsage")) {
        return new Response(
          JSON.stringify({
            planUsage: { limit: 7000, includedSpend: 7000, totalPercentUsed: 100 },
            spendLimitUsage: { individualLimit: 500, individualUsed: 331 },
            billingCycleEnd: "1788036931000",
            displayMessage: "You've used 98% of your included usage",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch
    try {
      const enriched = await enrichCursorSecrets({
        tokenType: "oauth",
        accessToken: "at-redacted",
        refreshToken: "rt-redacted",
      })
      expect(enriched.userId).toBe(77)
      expect(enriched.email).toBe("a@b.c")
      expect(enriched.planLimitCents).toBe(7000)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("returns the original bag untouched when probes fail or token is missing", async () => {
    const bag = { tokenType: "oauth", accessToken: "at" }
    expect(await enrichCursorSecrets({ tokenType: "oauth" })).toEqual({
      tokenType: "oauth",
    })
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch
    try {
      expect(await enrichCursorSecrets(bag)).toEqual(bag)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("projects persisted metadata into display-safe detail rows", () => {
    const details = cursorAccountDetails({
      tokenType: "oauth",
      accessToken: "at-redacted",
      userId: 51_930_405,
      email: "gaston@gastonmorixe.com",
      firstName: "Gaston",
      lastName: "M",
      country: "US",
      planLimitCents: 2000,
      includedSpendCents: 2000,
      totalPercentUsed: 100,
      bonusSpendCents: 32_733,
      onDemandLimitCents: 100,
      onDemandUsedCents: 158,
      billingCycleEndMs: 1_789_344_277_000,
      displayMessage: "You've hit your usage limit",
    } as never)
    const byKey = new Map(details.map((d) => [d.key, d.value]))
    expect(byKey.get("userId")).toBe("51930405")
    expect(byKey.get("email")).toBe("gaston@gastonmorixe.com")
    expect(byKey.get("name")).toBe("Gaston M")
    expect(byKey.get("plan")).toBe("$20.00 plan, $20.00 used")
    expect(byKey.get("bonus-spend")).toBe("$327.33")
    expect(byKey.get("on-demand")).toBe("$1.58 / $1.00")
    expect(byKey.get("usage-note")).toBe("You've hit your usage limit")
    // No secret material ever appears in rows.
    for (const row of details) {
      expect(row.value.includes("at-redacted")).toBe(false)
    }
  })

  it("surfaces identity + details through inspectCredential", () => {
    const info = inspectCursorOAuthCredential({
      tokenType: "oauth",
      accessToken: "at-redacted",
      refreshToken: "rt-redacted",
      expiresAt: 123,
      userId: 42,
      email: "a@b.c",
    } as never)
    expect(info.usable).toBe(true)
    expect(info.accountId).toBe("42")
    expect(info.hasRefreshToken).toBe(true)
    const byKey = new Map((info.details ?? []).map((d) => [d.key, d.value]))
    expect(byKey.get("userId")).toBe("42")
    expect(byKey.get("email")).toBe("a@b.c")
  })
})

describe("Cursor browser login", () => {
  it("builds deterministic loginDeepControl metadata without putting verifier in URL", () => {
    const challenge = createCursorLoginChallenge({
      verifierBytes: new Uint8Array(32).fill(7),
      uuid: "00000000-0000-4000-8000-000000000001",
      websiteUrl: "https://cursor.example",
    })
    const url = new URL(challenge.verificationUrl)
    expect(url.pathname).toBe("/loginDeepControl")
    expect(url.searchParams.get("uuid")).toBe(challenge.userCode)
    expect(url.searchParams.get("challenge")).toBeTruthy()
    expect(url.searchParams.has("verifier")).toBe(false)
    expect(challenge.providerData?.verifier).toBeTruthy()
  })

  it("polls 404 then builds an OAuth credential via fetch (verifier never on NetworkClient)", async () => {
    let calls = 0
    let sawVerifierInUrl = false
    let sawEnrichmentProbe = false
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (href.includes("verifier=")) sawVerifierInUrl = true
      if (href.includes("GetMe") || href.includes("GetCurrentPeriodUsage")) {
        sawEnrichmentProbe = true
        // GetMe: empty proto body; usage: `{}` JSON. Both fail harmlessly here.
        return new Response("{}", { status: 500 })
      }
      if (calls === 1) return new Response("{}", { status: 404 })
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBeNull() // poll carries secrets in URL only
      return new Response(
        JSON.stringify({ accessToken: "access-redacted", refreshToken: "refresh-redacted" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    try {
      const challenge = createCursorLoginChallenge({
        verifierBytes: new Uint8Array(32).fill(1),
        uuid: "00000000-0000-4000-8000-000000000002",
      })
      challenge.pollIntervalMs = 0
      // Dummy client required by completeCursorLogin; must not receive the poll URL.
      const client: NetworkClient = {
        async request() {
          throw new Error("poll must not use NetworkClient (verifier URL leak)")
        },
      }
      const built = await completeCursorLogin(challenge, { networkClient: client })
      // poll(404) + poll(200) + GetMe + GetCurrentPeriodUsage enrichment probes.
      expect(calls).toBe(4)
      expect(sawVerifierInUrl).toBe(true) // real request has verifier; not logged via NC
      expect(sawEnrichmentProbe).toBe(true)
      expect(built.credential.serviceId).toBe("cursor-oauth")
      expect(built.result.accessToken).toBe("access-redacted")
      expect(cursorOAuthLogin.readAuth?.(built.credential.secrets)).toEqual({
        kind: "oauth",
        token: "access-redacted",
        baseUrl: "https://api2.cursor.sh",
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("uses bounded exponential polling delay", () => {
    expect(cursorPollDelayMs(0)).toBe(1000)
    expect(cursorPollDelayMs(100)).toBe(10000)
  })
})

describe("Cursor headers", () => {
  it("matches Cursor Agent CLI: auth + request-id, no IDE checksum", () => {
    const headers = buildCursorHeaders({
      token: "access-redacted",
      ids: {
        machineId: "a".repeat(64),
        macMachineId: "b".repeat(64),
        clientKey: "c".repeat(64),
        sessionId: "session-redacted",
      },
      requestId: "request-redacted",
      nowMs: 1_700_000_000_000,
      streaming: false,
    })
    expect(headers.authorization).toBe("Bearer access-redacted")
    expect(headers["x-request-id"]).toBe("request-redacted")
    expect(headers["x-cursor-checksum"]).toBeUndefined()
    expect(headers["x-amzn-trace-id"]).toBeUndefined()
    expect(headers["content-type"]).toBe("application/proto")
  })
})
