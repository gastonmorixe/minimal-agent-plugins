import { describe, expect, it } from "bun:test"

import {
  buildCursorApiKeyCredential,
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
  cursorOAuthLogin,
  cursorPollDelayMs,
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
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls++
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (href.includes("verifier=")) sawVerifierInUrl = true
      if (calls === 1) return new Response("{}", { status: 404 })
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
      expect(calls).toBe(2)
      expect(sawVerifierInUrl).toBe(true) // real request has verifier; not logged via NC
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
  it("builds checksum, correlation, and Connect headers without secrets in ids", () => {
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
    expect(headers["x-cursor-checksum"]?.length).toBe(137)
    expect(headers["x-request-id"]).toBe("request-redacted")
    expect(headers["x-amzn-trace-id"]).toBe("Root=request-redacted")
    expect(headers["content-type"]).toBe("application/proto")
  })
})
