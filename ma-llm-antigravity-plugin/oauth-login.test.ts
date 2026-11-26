/**
 * Tests for the Antigravity OAuth strategy: URL shape, PKCE, the token
 * exchange, the refresh rule, and the credential hooks.
 *
 * The network is always a fake, so no test contacts Google. The one live path
 * is `antigravity.e2e.test.ts`, behind `E2E=1`.
 */
import { describe, expect, test } from "bun:test"

import type {
  NetworkClient,
  NetworkRequestInput,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import {
  type AntigravitySecrets,
  antigravitySecretsToBag,
  clearTokenExpiry,
  tokenNeedsRefresh,
} from "./auth.ts"
import {
  antigravityOAuthLogin,
  buildAuthorizeUrl,
  liveLoopbackServerCount,
  makePkce,
  refreshTokens,
  setLoopbackIdleMsForTest,
} from "./oauth-login.ts"
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
} from "./wire-constants.ts"

interface Call {
  input: NetworkRequestInput
  body: string
}

/**
 * Fake network client. Records every request and answers with the queued
 * responses in order, so a test can assert on the exact form body Google
 * receives.
 */
function fakeNetwork(responses: Array<{ status?: number; json: unknown }>): {
  client: NetworkClient
  calls: Call[]
} {
  const calls: Call[] = []
  let index = 0
  const client: NetworkClient = {
    async request(input: NetworkRequestInput): Promise<NetworkResponse> {
      const body = typeof input.body === "string" ? input.body : ""
      calls.push({ input, body })
      const next = responses[index++] ?? { status: 200, json: {} }
      const status = next.status ?? 200
      const text = JSON.stringify(next.json)
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers({ "content-type": "application/json" }),
        body: new Response(text).body as ReadableStream<Uint8Array>,
        transport: { id: "fake" },
        text: async () => text,
        json: async <T>() => JSON.parse(text) as T,
      }
    },
  }
  return { client, calls }
}

describe("makePkce", () => {
  test("makes a 43-character verifier from 32 bytes", () => {
    const { verifier } = makePkce()
    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("makes the S256 challenge of the verifier", async () => {
    const { verifier, challenge } = makePkce()
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    )
    const expected = Buffer.from(digest)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(challenge).toBe(expected)
    expect(challenge).not.toContain("=")
  })

  test("a second pair is different", () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier)
  })
})

describe("buildAuthorizeUrl", () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: "http://localhost:51234/auth/callback",
      state: "state-1",
      codeChallenge: "challenge-1",
      loginHint: "user@example.test",
    }),
  )

  test("targets the Google authorize endpoint", () => {
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL)
  })

  test("carries the agy client id and every scope in order", () => {
    expect(url.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID)
    expect(url.searchParams.get("scope")).toBe(ANTIGRAVITY_SCOPES.join(" "))
    expect(url.searchParams.get("scope")?.split(" ")).toHaveLength(7)
  })

  test("carries PKCE S256, offline access and consent", () => {
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1")
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("state")).toBe("state-1")
  })

  test("carries the loopback redirect and the login hint", () => {
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51234/auth/callback")
    expect(url.searchParams.get("login_hint")).toBe("user@example.test")
  })

  test("omits login_hint when absent", () => {
    const plain = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:1/auth/callback",
        state: "s",
        codeChallenge: "c",
      }),
    )
    expect(plain.searchParams.has("login_hint")).toBe(false)
  })
})

describe("exchangeCode", () => {
  test("posts a form body with the client secret and the verifier", async () => {
    const { client, calls } = fakeNetwork([
      { json: { access_token: "a", refresh_token: "r", expires_in: 3_599, scope: "openid" } },
    ])
    const { exchangeCode } = await import("./oauth-login.ts")
    const secrets = await exchangeCode({
      code: "the-code",
      redirectUri: "http://localhost:5555/auth/callback",
      verifier: "the-verifier",
      networkClient: client,
    })
    expect(calls).toHaveLength(1)
    const body = new URLSearchParams(calls[0]?.body)
    expect(calls[0]?.input.url).toBe(GOOGLE_TOKEN_URL)
    expect(calls[0]?.input.headers?.["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("the-code")
    expect(body.get("code_verifier")).toBe("the-verifier")
    expect(body.get("redirect_uri")).toBe("http://localhost:5555/auth/callback")
    expect(body.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID)
    expect(body.get("client_secret")).toBe(ANTIGRAVITY_CLIENT_SECRET)
    expect(secrets.accessToken).toBe("a")
    expect(secrets.refreshToken).toBe("r")
    expect(secrets.authMethod).toBe("consumer")
  })

  test("never logs the exchange body", async () => {
    const { client, calls } = fakeNetwork([{ json: { access_token: "a", refresh_token: "r" } }])
    const { exchangeCode } = await import("./oauth-login.ts")
    await exchangeCode({
      code: "c",
      redirectUri: "http://localhost:1/auth/callback",
      verifier: "v",
      networkClient: client,
    })
    expect(calls[0]?.input.capture?.requestBody).toBe("[REDACTED OAUTH EXCHANGE BODY]")
  })

  test("throws with the provider message on a rejected code", async () => {
    const { client } = fakeNetwork([
      { status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } },
    ])
    const { exchangeCode } = await import("./oauth-login.ts")
    await expect(
      exchangeCode({
        code: "c",
        redirectUri: "http://localhost:1/auth/callback",
        verifier: "v",
        networkClient: client,
      }),
    ).rejects.toThrow("token exchange failed: Bad Request")
  })
})

describe("refreshTokens", () => {
  test("posts the refresh grant and returns a new expiry", async () => {
    const { client, calls } = fakeNetwork([{ json: { access_token: "next", expires_in: 3_599 } }])
    const before = Date.now()
    const next = await refreshTokens({ refreshToken: "old-refresh", networkClient: client })
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("old-refresh")
    expect(body.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID)
    expect(body.get("client_secret")).toBe(ANTIGRAVITY_CLIENT_SECRET)
    expect(next.accessToken).toBe("next")
    expect(next.expiresAt ?? 0).toBeGreaterThan(before)
    // A refresh response normally has no new refresh token.
    expect(next.refreshToken).toBeUndefined()
  })

  test("keeps a new refresh token when Google rotates one", async () => {
    const { client } = fakeNetwork([{ json: { access_token: "next", refresh_token: "rotated" } }])
    const next = await refreshTokens({ refreshToken: "old", networkClient: client })
    expect(next.refreshToken).toBe("rotated")
  })

  test("throws on a rejected refresh", async () => {
    const { client } = fakeNetwork([{ status: 401, json: { error: "invalid_grant" } }])
    await expect(refreshTokens({ refreshToken: "x", networkClient: client })).rejects.toThrow(
      "refresh failed",
    )
  })
})

describe("antigravityOAuthLogin", () => {
  test("has the credential identity the host stores", () => {
    expect(antigravityOAuthLogin.serviceId).toBe("antigravity-oauth")
    expect(antigravityOAuthLogin.displayName).toBe("Antigravity (Google OAuth)")
  })

  test("config() describes a form-encoded loopback login with the 7 scopes", () => {
    const config = antigravityOAuthLogin.config()
    expect(config.clientId).toBe(ANTIGRAVITY_CLIENT_ID)
    expect(config.authorizeUrl).toBe(GOOGLE_AUTHORIZE_URL)
    expect(config.tokenUrl).toBe(GOOGLE_TOKEN_URL)
    expect(config.scopes).toEqual(ANTIGRAVITY_SCOPES as string[])
    expect(config.tokenRequestEncoding).toBe("form")
    expect(config.tokenRequestIncludesState).toBe(false)
    expect(config.authorizeParams).toEqual({ access_type: "offline", prompt: "consent" })
  })

  test("readAuth builds a bearer, and the host adds the refresh callback", async () => {
    const secrets = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    })
    const auth = antigravityOAuthLogin.readAuth?.(secrets)
    expect(auth?.kind).toBe("oauth")
    if (auth?.kind === "oauth") {
      expect(auth.token).toBe("token")
      // The host wraps `refreshCredential`, which also writes the store.
      expect(auth.refresh).toBeUndefined()
    }
  })

  test("readAuth records the expiry, so the adapter can refresh before a turn", () => {
    clearTokenExpiry()
    const near = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "near",
      refreshToken: "refresh",
      expiresAt: Date.now() + 30_000,
    })
    const far = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "far",
      refreshToken: "refresh",
      expiresAt: Date.now() + 30 * 60_000,
    })
    antigravityOAuthLogin.readAuth?.(near)
    antigravityOAuthLogin.readAuth?.(far)
    expect(tokenNeedsRefresh("near")).toBe(true)
    expect(tokenNeedsRefresh("far")).toBe(false)
    expect(tokenNeedsRefresh("unknown")).toBe(false)
  })

  test("readAuth returns null for a bag with no tokens", () => {
    expect(antigravityOAuthLogin.readAuth?.({})).toBeNull()
  })

  test("inspectCredential reports the account rows and expiry", () => {
    const secrets = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 600_000,
      email: "user@example.test",
      authMethod: "consumer",
      project: "aicode-consumers",
    })
    const info = antigravityOAuthLogin.inspectCredential?.(secrets)
    expect(info?.usable).toBe(true)
    expect(info?.hasRefreshToken).toBe(true)
    expect(info?.details?.map((row) => row.key)).toEqual(["email", "plan", "project"])
  })

  test("inspectCredential keeps an expired credential usable when it has a refresh token", () => {
    const expiresAt = Date.now() - 2 * 60 * 60_000
    const secrets = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt,
    })
    const info = antigravityOAuthLogin.inspectCredential?.(secrets)
    expect(info?.usable).toBe(true)
    expect(info?.expiresAt).toBe(expiresAt)
    expect(info?.hasRefreshToken).toBe(true)
  })

  test("inspectCredential marks a bag with no refresh token unusable", () => {
    const info = antigravityOAuthLogin.inspectCredential?.({ accessToken: "token" })
    expect(info?.usable).toBe(false)
  })

  test("credentialIds returns the email so a user can pick this account", () => {
    const secrets = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "t",
      refreshToken: "r",
      expiresAt: Date.now() + 1_000,
      email: "user@example.test",
    })
    expect(antigravityOAuthLogin.credentialIds?.(secrets)).toEqual(["user@example.test"])
    expect(antigravityOAuthLogin.credentialIds?.({})).toEqual([])
  })

  test("refreshCredential keeps the old refresh token when the response has none", async () => {
    const { client } = fakeNetwork([{ json: { access_token: "new-access", expires_in: 3_599 } }])
    const stored = antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: "old-access",
      refreshToken: "keep-me",
      expiresAt: Date.now() + 1_000,
      email: "user@example.test",
    })
    const write = await antigravityOAuthLogin.refreshCredential?.(stored, { networkClient: client })
    expect(write?.credential.secrets.accessToken).toBe("new-access")
    expect(write?.credential.secrets.refreshToken).toBe("keep-me")
    expect(write?.credential.secrets.email).toBe("user@example.test")
    expect(write?.result.accessToken).toBe("new-access")
  })

  test("refreshCredential throws for a bag with no refresh token", async () => {
    await expect(antigravityOAuthLogin.refreshCredential?.({}, {})).rejects.toThrow(
      "no refresh token",
    )
  })
})

describe("deviceCode hook", () => {
  test("request() returns the authorize URL and an empty user code", async () => {
    const controller = new AbortController()
    const challenge = await antigravityOAuthLogin.deviceCode?.request({ signal: controller.signal })
    const url = new URL(challenge?.verificationUrl ?? "")
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_URL)
    expect(challenge?.userCode).toBe("")
    // The redirect in the URL must match the server's real port.
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
    const data = challenge?.providerData as {
      state?: string
      verifier?: string
      redirectUri?: string
    }
    expect(data.state?.length).toBeGreaterThan(20)
    expect(data.verifier).toHaveLength(43)
    expect(data.redirectUri).toBe(url.searchParams.get("redirect_uri") ?? "")
    controller.abort()
  })

  test("complete() exchanges the code and returns the credential write", async () => {
    const controller = new AbortController()
    const challenge = await antigravityOAuthLogin.deviceCode?.request({ signal: controller.signal })
    const data = challenge?.providerData as { state: string; redirectUri: string }
    const { client, calls } = fakeNetwork([
      {
        json: {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3_599,
          scope: "openid",
        },
      },
      { json: { email: "user@example.test" } },
    ])
    const pending = antigravityOAuthLogin.deviceCode?.complete(challenge!, {
      networkClient: client,
      signal: controller.signal,
    })
    // Simulate the browser: hit the loopback URL with the real state.
    await fetch(`${data.redirectUri}?code=the-code&state=${encodeURIComponent(data.state ?? "")}`, {
      redirect: "manual",
    })
    const write = await pending
    expect(write?.credential.serviceId).toBe("antigravity-oauth")
    const bag = write?.credential.secrets as Record<string, unknown>
    expect(bag.accessToken).toBe("fresh-access")
    expect(bag.refreshToken).toBe("fresh-refresh")
    expect(bag.email).toBe("user@example.test")
    expect(write?.result.accessToken).toBe("fresh-access")
    expect(calls[0]?.input.url).toBe(GOOGLE_TOKEN_URL)
    expect(calls[1]?.input.url).toContain("userinfo")
  })

  test("complete() rejects on a state mismatch", async () => {
    const controller = new AbortController()
    const challenge = await antigravityOAuthLogin.deviceCode?.request({ signal: controller.signal })
    const data = challenge?.providerData as { redirectUri: string }
    const { client } = fakeNetwork([{ json: { access_token: "a", refresh_token: "r" } }])
    // Observe the failure as a value: it settles while `fetch` is in flight.
    const outcome = antigravityOAuthLogin.deviceCode
      ?.complete(challenge!, { networkClient: client, signal: controller.signal })
      .then(
        () => ({ ok: true as const, message: "" }),
        (error: Error) => ({ ok: false as const, message: error.message }),
      )
    await fetch(`${data.redirectUri}?code=c&state=wrong-state`, { redirect: "manual" })
    const settled = await outcome
    expect(settled?.ok).toBe(false)
    expect(settled?.message).toBe("antigravity login: state mismatch")
  })

  test("an abandoned login closes its loopback server after the idle time", async () => {
    setLoopbackIdleMsForTest(20)
    try {
      const challenge = await antigravityOAuthLogin.deviceCode?.request({})
      if (!challenge) throw new Error("test fixture: the deviceCode hook must exist")
      expect(liveLoopbackServerCount()).toBe(1)
      await Bun.sleep(60)
      expect(liveLoopbackServerCount()).toBe(0)
      // The port is closed, so the redirect gets no answer.
      const redirect = (challenge.providerData as { redirectUri: string }).redirectUri
      await expect(fetch(redirect)).rejects.toThrow()
      // A late `complete` reports the lost state instead of waiting forever.
      await expect(antigravityOAuthLogin.deviceCode?.complete(challenge, {})).rejects.toThrow(
        "server state lost",
      )
    } finally {
      setLoopbackIdleMsForTest()
    }
  })

  test("request() refuses an already aborted login", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      antigravityOAuthLogin.deviceCode?.request({ signal: controller.signal }),
    ).rejects.toThrow("aborted")
  })
})

describe("buildCredential", () => {
  test("maps a Google token response into the stored bag", () => {
    const write = antigravityOAuthLogin.buildCredential({
      access_token: "build-access",
      refresh_token: "build-refresh",
      expires_in: 60,
      scope: "openid profile",
    })
    const bag = write.credential.secrets as unknown as AntigravitySecrets
    expect(bag.accessToken).toBe("build-access")
    expect(bag.refreshToken).toBe("build-refresh")
    expect(write.result.scopes).toEqual(["openid", "profile"])
  })

  test("throws when the response has no access token", () => {
    expect(() => antigravityOAuthLogin.buildCredential({})).toThrow("no access token")
  })
})
