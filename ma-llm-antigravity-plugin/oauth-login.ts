/**
 * Google OAuth login for the Antigravity provider.
 *
 * The flow is the one the `agy` CLI runs, reproduced field for field:
 *
 * 1. PKCE verifier (43 chars) plus state, then a one-shot loopback server.
 * 2. The authorize URL opens in the browser: the 7 `agy` scopes, `S256`,
 *    `access_type=offline`, `prompt=consent`.
 * 3. Google redirects to `http://localhost:<port>/auth/callback`.
 * 4. The code is exchanged at `https://oauth2.googleapis.com/token` with the
 *    installed-app `client_secret`, which Google requires for this client.
 * 5. The profile is read for the email, then the credential is written to the
 *    host store.
 *
 * The host's own PKCE orchestrator cannot do step 4: `exchangeCodeForTokens`
 * in core sends no `client_secret`, and this client rejects an exchange
 * without one. So the whole flow lives inside the `deviceCode` hook, which the
 * host runs when a provider declares it. `userCode` is an empty string on
 * purpose: Google shows nothing to type, and the login finishes in the browser.
 *
 * @module llm/providers/antigravity/oauth-login
 */

import { createHash, randomBytes } from "node:crypto"

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import {
  type AntigravitySecrets,
  antigravityExpiresAt,
  antigravitySecretsToBag,
  readAntigravitySecrets,
  rememberTokenExpiry,
} from "./auth.ts"
import type {
  AuthCredentialInfo,
  AuthSecretBag,
  OAuthCredentialRefreshContext,
  OAuthDeviceCodeChallenge,
  OAuthDeviceCodeContext,
  OAuthLoginBuildResult,
  OAuthLoginProvider,
} from "./lib/provider-plugin.ts"
import { LOOPBACK_TIMEOUT_MS, startLoopbackServer } from "./loopback-server.ts"
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_CREDENTIAL_NAME,
  ANTIGRAVITY_LOOPBACK_PATH,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_SERVICE_ID,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from "./wire-constants.ts"

/** Identity of the credential in the host store. */
export const ANTIGRAVITY_OAUTH = {
  serviceId: ANTIGRAVITY_SERVICE_ID,
  displayName: ANTIGRAVITY_CREDENTIAL_NAME,
} as const

/** The provider reads the client id and secret from the environment when set. */
function clientId(): string {
  return process.env.ANTIGRAVITY_CLIENT_ID?.trim() || ANTIGRAVITY_CLIENT_ID
}

function clientSecret(): string {
  return process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() || ANTIGRAVITY_CLIENT_SECRET
}

function network(client: NetworkClient | undefined): NetworkClient {
  if (!client) throw new Error("antigravity login: missing network client")
  return client
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * PKCE pair. Google requires `code_challenge_method=S256`, so the challenge is
 * the base64url SHA-256 of the verifier with no padding. A 32-byte verifier
 * gives the 43-character minimum length that RFC 7636 requires.
 */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

/** Random `state` for the CSRF check. 32 bytes, base64url. */
export function makeState(): string {
  return base64url(randomBytes(32))
}

/**
 * Build the Google authorize URL.
 *
 * The scope order is the `agy` order. The parameter set is the one the client
 * accepts: a loopback redirect of any port was verified against the live
 * endpoint on 2026-11-25.
 */
export function buildAuthorizeUrl(input: {
  redirectUri: string
  state: string
  codeChallenge: string
  loginHint?: string
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set("client_id", clientId())
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint)
  return url.toString()
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  id_token?: string
  error?: string
  error_description?: string
}

async function readJson(response: { text(): Promise<string> }): Promise<GoogleTokenResponse> {
  const raw = await response.text()
  try {
    return JSON.parse(raw) as GoogleTokenResponse
  } catch {
    return { error: "invalid_response", error_description: raw.slice(0, 200) }
  }
}

/**
 * Exchange an authorization code for tokens.
 *
 * The body is `application/x-www-form-urlencoded` because that is what Google
 * documents, and it carries `client_secret` because this installed-app client
 * requires it. The request opts out of body capture: the code and the verifier
 * are single-use secrets.
 */
export async function exchangeCode(input: {
  code: string
  redirectUri: string
  verifier: string
  networkClient?: NetworkClient
}): Promise<AntigravitySecrets> {
  const response = await network(input.networkClient).request({
    label: "antigravity.login.exchange",
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: clientId(),
      client_secret: clientSecret(),
      code_verifier: input.verifier,
    }).toString(),
    capture: { requestBody: "[REDACTED OAUTH EXCHANGE BODY]", responseBody: false },
  })
  const json = await readJson(response)
  if (!response.ok || !json.access_token) {
    const detail = json.error_description ?? json.error ?? `status ${response.status}`
    throw new Error(`antigravity login: token exchange failed: ${detail}`)
  }
  return {
    tokenType: "oauth",
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    expiresAt: antigravityExpiresAt(json as Record<string, unknown>),
    idToken: json.id_token,
    authMethod: "consumer",
    scope: json.scope,
  }
}

/**
 * Refresh an access token.
 *
 * A refresh response from this client normally has no `refresh_token`, so the
 * caller must keep the old one. That rule lives in
 * {@link antigravityOAuthLogin.refreshCredential}, not here, so a direct
 * caller cannot lose it by accident.
 */
export async function refreshTokens(input: {
  refreshToken: string
  networkClient?: NetworkClient
  signal?: AbortSignal
}): Promise<Partial<AntigravitySecrets> & { accessToken: string }> {
  const response = await network(input.networkClient).request({
    label: "antigravity.login.refresh",
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
    }).toString(),
    signal: input.signal,
    capture: { requestBody: "[REDACTED OAUTH REFRESH BODY]", responseBody: false },
  })
  const json = await readJson(response)
  if (!response.ok || !json.access_token) {
    const detail = json.error_description ?? json.error ?? `status ${response.status}`
    throw new Error(`antigravity login: refresh failed: ${detail}`)
  }
  return {
    accessToken: json.access_token,
    idToken: json.id_token,
    scope: json.scope,
    expiresAt: antigravityExpiresAt(json as Record<string, unknown>),
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
  }
}

/**
 * Read the account email for diagnostics.
 *
 * Best-effort on purpose: a profile failure must never fail a login that
 * already holds a good token.
 */
async function fetchEmail(
  accessToken: string,
  client?: NetworkClient,
): Promise<string | undefined> {
  if (!client) return undefined
  try {
    const response = await client.request({
      label: "antigravity.login.userinfo",
      method: "GET",
      url: GOOGLE_USERINFO_URL,
      headers: { authorization: `Bearer ${accessToken}` },
      capture: { responseBody: false },
    })
    if (!response.ok) return undefined
    const json = (await response.json()) as { email?: string }
    return typeof json.email === "string" ? json.email : undefined
  } catch {
    return undefined
  }
}

function toCredential(secrets: AntigravitySecrets): {
  credential: { serviceId: string; displayName: string; secrets: AuthSecretBag }
  result: { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }
} {
  return {
    credential: {
      serviceId: ANTIGRAVITY_OAUTH.serviceId,
      displayName: ANTIGRAVITY_OAUTH.displayName,
      secrets: antigravitySecretsToBag(secrets),
    },
    result: {
      accessToken: secrets.accessToken,
      refreshToken: secrets.refreshToken,
      expiresAt: secrets.expiresAt,
      scopes: (secrets.scope ?? ANTIGRAVITY_SCOPES.join(" ")).split(" ").filter(Boolean),
    },
  }
}

/** Shape stored in the challenge so `complete` needs no closure state. */
interface LoopbackProviderData extends AuthSecretBag {
  state: string
  verifier: string
  redirectUri: string
}

/**
 * The provider's OAuth strategy.
 *
 * `config()` still returns a full config because the host reads it before it
 * picks a path. `deviceCode` is what actually runs, so the paste path is never
 * used: it cannot send the `client_secret` that this client requires.
 */
export const antigravityOAuthLogin: OAuthLoginProvider = {
  serviceId: ANTIGRAVITY_OAUTH.serviceId,
  displayName: ANTIGRAVITY_OAUTH.displayName,

  config() {
    return {
      clientId: clientId(),
      authorizeUrl: GOOGLE_AUTHORIZE_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      redirectUri: `http://localhost:0${ANTIGRAVITY_LOOPBACK_PATH}`,
      scopes: ANTIGRAVITY_SCOPES,
      authorizeParams: { access_type: "offline", prompt: "consent" },
      tokenRequestEncoding: "form",
      tokenRequestIncludesState: false,
    }
  },

  deviceCode: {
    async request(ctx: OAuthDeviceCodeContext): Promise<OAuthDeviceCodeChallenge> {
      if (ctx.signal?.aborted) throw new Error("antigravity login: aborted")
      // A new attempt supersedes any server left behind by an abandoned one.
      // Without this, a retry in the same process would hold two listeners.
      for (const stale of servers.values()) {
        clearTimeout(stale.idle)
        stale.server.close()
      }
      servers.clear()
      const server = startLoopbackServer()
      const { verifier, challenge } = makePkce()
      const state = makeState()
      // The state is unique per attempt, so it identifies the server without
      // relying on the caller passing the same `signal` object twice.
      servers.set(state, { server, idle: idleTimer(state) })
      const authorizeUrl = buildAuthorizeUrl({
        redirectUri: server.redirectUri,
        state,
        codeChallenge: challenge,
      })
      const providerData: LoopbackProviderData = {
        state,
        verifier,
        redirectUri: server.redirectUri,
      }
      return {
        verificationUrl: authorizeUrl,
        userCode: "",
        expiresInMs: LOOPBACK_TIMEOUT_MS,
        providerData,
      }
    },

    async complete(
      challenge: OAuthDeviceCodeChallenge,
      ctx: OAuthDeviceCodeContext,
    ): Promise<OAuthLoginBuildResult> {
      const data = challenge.providerData as LoopbackProviderData | undefined
      const entry = data ? servers.get(data.state) : undefined
      if (!data || !entry) throw new Error("antigravity login: server state lost")
      servers.delete(data.state)
      clearTimeout(entry.idle)
      const server = entry.server
      try {
        const callback = await server.wait(ctx.signal, challenge.expiresInMs)
        if (callback.state !== data.state) throw new Error("antigravity login: state mismatch")
        const exchanged = await exchangeCode({
          code: callback.code,
          redirectUri: data.redirectUri,
          verifier: data.verifier,
          networkClient: ctx.networkClient as NetworkClient | undefined,
        })
        const email = await fetchEmail(
          exchanged.accessToken,
          ctx.networkClient as NetworkClient | undefined,
        )
        const secrets: AntigravitySecrets = { ...exchanged, ...(email ? { email } : {}) }
        return toCredential(secrets)
      } finally {
        server.close()
      }
    },
  },

  buildCredential(response: Record<string, unknown>): OAuthLoginBuildResult {
    const accessToken = String(response.access_token ?? "")
    if (!accessToken) throw new Error("antigravity login: response has no access token")
    return toCredential({
      tokenType: "oauth",
      accessToken,
      refreshToken: String(response.refresh_token ?? ""),
      expiresAt: antigravityExpiresAt(response),
      authMethod: "consumer",
      scope: typeof response.scope === "string" ? response.scope : undefined,
    })
  },

  /**
   * The bearer of a stored credential.
   *
   * No `refresh` here: the host adds one from {@link refreshCredential}, and
   * that one also writes the new token to the store. The expiry is recorded
   * so the adapter can refresh before a turn (see `adapter.ts`).
   */
  readAuth(secrets: AuthSecretBag): ProviderAuth | null {
    const parsed = readAntigravitySecrets(secrets)
    if (!parsed) return null
    rememberTokenExpiry(parsed.accessToken, parsed.expiresAt)
    return { kind: "oauth", token: parsed.accessToken }
  },

  inspectCredential(secrets: AuthSecretBag): AuthCredentialInfo {
    const parsed = readAntigravitySecrets(secrets)
    if (!parsed) return { usable: false, label: ANTIGRAVITY_OAUTH.displayName }
    const details = []
    if (parsed.email) details.push({ key: "email", label: "Account", value: parsed.email })
    details.push({ key: "plan", label: "Plan", value: parsed.authMethod ?? "consumer" })
    if (parsed.project) details.push({ key: "project", label: "Project", value: parsed.project })
    // `readAntigravitySecrets` gives a bag only when it has a refresh token,
    // and that token renews an expired access token. So the credential is
    // usable, and the expiry is reported through `expiresAt` only. The cli
    // drops a credential with `usable: false`.
    return {
      usable: true,
      label: ANTIGRAVITY_OAUTH.displayName,
      expiresAt: parsed.expiresAt,
      hasRefreshToken: parsed.refreshToken.length > 0,
      scopes: (parsed.scope ?? "").split(" ").filter(Boolean),
      details,
    }
  },

  credentialIds(secrets: AuthSecretBag): readonly string[] {
    const parsed = readAntigravitySecrets(secrets)
    return parsed?.email ? [parsed.email] : []
  },

  async refreshCredential(
    secrets: AuthSecretBag,
    ctx: OAuthCredentialRefreshContext,
  ): Promise<OAuthLoginBuildResult> {
    const parsed = readAntigravitySecrets(secrets)
    if (!parsed) throw new Error("antigravity login: credential has no refresh token")
    const next = await refreshTokens({
      refreshToken: parsed.refreshToken,
      networkClient: ctx.networkClient as NetworkClient | undefined,
      signal: ctx.signal,
    })
    // A refresh response normally omits the refresh token, so keep the old one.
    const merged: AntigravitySecrets = {
      ...parsed,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? parsed.refreshToken,
      expiresAt: next.expiresAt ?? parsed.expiresAt,
      idToken: next.idToken ?? parsed.idToken,
      scope: next.scope ?? parsed.scope,
    }
    return toCredential(merged)
  },
}

/** One live loopback server and the idle timer that closes it. */
interface LoopbackEntry {
  server: ReturnType<typeof startLoopbackServer>
  idle: ReturnType<typeof setTimeout>
}

/** Idle time of an abandoned loopback server. Tests make it short. */
let loopbackIdleMs = LOOPBACK_TIMEOUT_MS

/** Test seam: set the idle time of the next loopback servers. */
export function setLoopbackIdleMsForTest(ms: number = LOOPBACK_TIMEOUT_MS): void {
  loopbackIdleMs = ms
}

/** Live loopback servers, keyed by the unique `state` of their login attempt. */
const servers = new Map<string, LoopbackEntry>()

/**
 * Close the server of an abandoned login after {@link LOOPBACK_TIMEOUT_MS}.
 * `complete` clears the timer, and `wait` then has its own timeout.
 */
function idleTimer(state: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const entry = servers.get(state)
    if (!entry) return
    servers.delete(state)
    entry.server.close()
  }, loopbackIdleMs)
  timer.unref?.()
  return timer
}

/** Count of live loopback servers. Exported for tests. */
export function liveLoopbackServerCount(): number {
  return servers.size
}
