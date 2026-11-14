/**
 * Plan OAuth after the move out of core (decision 39).
 *
 * Core no longer holds an Anthropic OAuth client. This plugin owns the
 * endpoints, the client id, the token exchange codec, and the refresh. These
 * tests prove that the user sees no change:
 *
 * - A store file that the old core client wrote still loads through the
 *   generic provider-plugin auth contract.
 * - The login flow works against a fake OAuth server on 127.0.0.1.
 * - A refresh of the legacy credential works against the same fake server.
 *
 * No test touches the real network.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { AuthStore, resetDefaultAuthStoreForTests } from "@minimal-agent/core/host/auth-store"
import {
  discoverCredentialedProviders,
  tryResolveProviderAuth,
} from "@minimal-agent/core/host/auth-strategies"
import { defaultNetworkClient } from "@minimal-agent/core/host/network"
import { runOAuthLogin } from "@minimal-agent/core/host/oauth-login"
import {
  clearProviderPlugins,
  registerProviderPlugin,
} from "@minimal-agent/core/host/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import { anthropicProviderPlugin } from "./adapter.ts"
import { anthropicOAuthLogin, refreshAnthropicOAuthCredential } from "./oauth-login.ts"

/** The store file the old core client (`writeCredentials`) wrote. */
const LEGACY_FIXTURE = join(import.meta.dir, "__fixtures__", "legacy-core-auth-store.jsonc")
/** The store key the old core client used (`ANTHROPIC_PLAN_OAUTH`). */
const LEGACY_ID = "anthropic-plan-oauth"
const LEGACY_NAME = "Anthropic Plan (OAuth)"

interface SeenRequest {
  path: string
  body: Record<string, unknown>
}

/** A fake OAuth token endpoint on 127.0.0.1. */
function startFakeOAuthServer(status = 200): {
  url: string
  seen: SeenRequest[]
  stop: () => void
} {
  const seen: SeenRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = (await req.json()) as Record<string, unknown>
      seen.push({ path, body })
      if (status !== 200) return new Response('{"error":"invalid_grant"}', { status })
      const grant = body.grant_type
      return Response.json({
        access_token: grant === "refresh_token" ? "refreshed-access" : "login-access",
        refresh_token: grant === "refresh_token" ? "refreshed-refresh" : "login-refresh",
        expires_in: 3600,
        scope: "user:profile user:inference",
        account: { uuid: "acct-login", email_address: "login@example.invalid" },
        organization: { uuid: "org-login" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1/oauth/token`,
    seen,
    stop: () => server.stop(true),
  }
}

/**
 * A network client that sends every request to `target` and records the
 * URL the plugin asked for. The plugin refresh has a fixed token URL. This
 * keeps the request on 127.0.0.1.
 */
function redirectingClient(target: string, asked: string[]): NetworkClient {
  return {
    request(input) {
      asked.push(input.url)
      return defaultNetworkClient.request({ ...input, url: target })
    },
  }
}

describe("anthropic plan OAuth: legacy core store (decision 39)", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-anthropic-legacy-auth-"))
    copyFileSync(LEGACY_FIXTURE, join(dir, "auth.jsonc"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearProviderPlugins()
    registerProviderPlugin(anthropicProviderPlugin)
  })

  afterEach(() => {
    clearProviderPlugins()
    resetDefaultAuthStoreForTests()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    rmSync(dir, { recursive: true, force: true })
  })

  it("the plugin claims the store key that the old core client used", () => {
    expect(anthropicOAuthLogin.serviceId).toBe(LEGACY_ID)
    expect(anthropicOAuthLogin.displayName).toBe(LEGACY_NAME)
  })

  it("loads the legacy entry through the generic contract", () => {
    const auth = tryResolveProviderAuth("anthropic")
    expect(auth?.kind).toBe("oauth")
    if (auth?.kind !== "oauth") throw new Error("expected oauth auth")
    expect(auth.token).toBe("legacy-access-token")
    expect(typeof auth.refresh).toBe("function")
  })

  it("shows the legacy entry metadata in the credential list", () => {
    const [entry, ...rest] = discoverCredentialedProviders()
    expect(rest).toEqual([])
    expect(entry?.providerId).toBe("anthropic")
    expect(entry?.credentialName).toBe(LEGACY_NAME)
    expect(entry?.credentialInfo).toMatchObject({
      usable: true,
      hasRefreshToken: true,
      expiresAt: 1774880291250,
      accountId: "acct-0000-legacy",
      organizationId: "org-0000-legacy",
    })
  })

  it("refreshes the legacy entry against a fake server and keeps the account data", async () => {
    const server = startFakeOAuthServer()
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      const legacy = store.getSecrets(LEGACY_ID, LEGACY_NAME)
      if (!legacy) throw new Error("fixture entry is missing")
      const asked: string[] = []
      const refreshed = await refreshAnthropicOAuthCredential(legacy, {
        networkClient: redirectingClient(server.url, asked),
      })
      expect(asked).toEqual(["https://platform.claude.com/v1/oauth/token"])
      expect(server.seen[0]?.body).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "legacy-refresh-token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      })
      expect(refreshed.credential.serviceId).toBe(LEGACY_ID)
      expect(refreshed.credential.secrets).toMatchObject({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        accountUuid: "acct-login",
        emailAddress: "login@example.invalid",
        organizationUuid: "org-login",
      })
    } finally {
      server.stop()
    }
  })

  it("a rejected refresh fails and names the server status", async () => {
    const server = startFakeOAuthServer(400)
    try {
      const legacy = new AuthStore({ path: join(dir, "auth.jsonc") }).getSecrets(
        LEGACY_ID,
        LEGACY_NAME,
      )
      if (!legacy) throw new Error("fixture entry is missing")
      const run = refreshAnthropicOAuthCredential(legacy, {
        networkClient: redirectingClient(server.url, []),
      })
      await expect(run).rejects.toThrow(/refresh failed \(400\).*invalid_grant/)
    } finally {
      server.stop()
    }
  })
})

describe("anthropic plan OAuth: login against a fake 127.0.0.1 server", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-anthropic-login-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function login(server: { url: string }, store: AuthStore) {
    let authUrl = ""
    return await runOAuthLogin({
      provider: anthropicOAuthLogin,
      tokenUrl: server.url,
      networkClient: defaultNetworkClient,
      openUrl: async (url) => {
        authUrl = url
        return true
      },
      readPaste: async () => {
        const state = new URL(authUrl).searchParams.get("state")
        return `the-auth-code#${state}`
      },
      install: { store },
      maxAttempts: 1,
    })
  }

  it("exchanges the code and stores a credential the generic contract reads", async () => {
    const server = startFakeOAuthServer()
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      const outcome = await login(server, store)
      expect(outcome.ok).toBe(true)
      expect(server.seen).toHaveLength(1)
      expect(server.seen[0]?.path).toBe("/v1/oauth/token")
      expect(server.seen[0]?.body).toMatchObject({
        grant_type: "authorization_code",
        code: "the-auth-code",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      })
      // A login with no name gets the next `{serviceId}-N` (core 83a0740).
      // Only an entry from before that change has the display name.
      const secrets = new AuthStore({ path: join(dir, "auth.jsonc") }).getSecrets(
        LEGACY_ID,
        `${LEGACY_ID}-1`,
      )
      if (!secrets) throw new Error("login wrote no entry")
      expect(anthropicOAuthLogin.readAuth?.(secrets)).toEqual({
        kind: "oauth",
        token: "login-access",
      })
      expect(secrets).toMatchObject({ refreshToken: "login-refresh", accountUuid: "acct-login" })
    } finally {
      server.stop()
    }
  })

  it("a rejected exchange stores nothing", async () => {
    const server = startFakeOAuthServer(400)
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      await expect(login(server, store)).rejects.toMatchObject({
        kind: "TokenExchangeError",
        status: 400,
      })
      expect(store.list()).toEqual([])
    } finally {
      server.stop()
    }
  })
})
