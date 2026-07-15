/**
 * ClinePass OAuth via WorkOS device-code (preferred) + Cline token register/refresh.
 *
 * Flow (mirrors Cline CLI `loginClineOAuth` with `useWorkOSDeviceAuth: true`):
 * 1. POST WorkOS `/user_management/authorize/device` with Cline's WorkOS client id
 * 2. User enters PIN at verification_uri
 * 3. Poll WorkOS `/user_management/authenticate` with device_code grant
 * 4. POST Cline `/api/v1/auth/register` with WorkOS access+refresh → Cline tokens
 * 5. Refresh later via POST `/api/v1/auth/refresh` `{ refreshToken, grantType }`
 *
 * API-key auth remains available for third-party clients without OAuth.
 *
 * @module llm/providers/clinepass/oauth-login
 */

import type { NetworkClient } from "./lib/net-types.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type {
  AuthCredentialInfo,
  AuthSecretBag,
  OAuthCredentialRefreshContext,
  OAuthDeviceCodeChallenge,
  OAuthDeviceCodeContext,
  OAuthLoginBuildResult,
  OAuthLoginConfig,
  OAuthLoginProvider,
} from "./lib/provider-plugin.ts"
import {
  CLINE_AUTH,
  CLINE_OPENAI_BASE,
  CLINE_WORKOS_CLIENT_ID,
  CLINEPASS_DEFAULT_HEADERS,
  WORKOS_AUTHENTICATE_URL,
  WORKOS_DEVICE_AUTHORIZATION_URL,
} from "./wire-constants.ts"

export const CLINEPASS_OAUTH = {
  serviceId: "clinepass-oauth",
  displayName: "ClinePass (OAuth)",
} as const

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_POLL_MS = 5_000

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function network(ctx: OAuthDeviceCodeContext | OAuthCredentialRefreshContext): NetworkClient {
  const client = ctx.networkClient as NetworkClient | undefined
  if (!client) throw new Error("ClinePass OAuth: missing network client")
  return client
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error("ClinePass OAuth aborted")
  err.name = "AbortError"
  throw err
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      const err = new Error("ClinePass OAuth aborted")
      err.name = "AbortError"
      reject(err)
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Host PKCE config is unused for device-code login, but the contract requires
 * a config() for providers that also support browser PKCE. Point at Cline's
 * authorize/token endpoints so a future PKCE path can reuse them.
 */
export function clinepassOAuthConfig(): OAuthLoginConfig {
  return {
    clientId: CLINE_WORKOS_CLIENT_ID,
    authorizeUrl: CLINE_AUTH.authorize,
    tokenUrl: CLINE_AUTH.token,
    redirectUri: "http://127.0.0.1:48801/auth",
    scopes: [],
    tokenRequestEncoding: "json",
    tokenRequestIncludesState: false,
  }
}

/** Encode Cline token response fields into the host secret bag. */
export function clinepassOAuthToSecrets(input: {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  userId?: string
  tokenType?: string
}): AuthSecretBag {
  return {
    tokenType: "oauth",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    ...(input.email ? { email: input.email } : {}),
    ...(input.userId ? { userId: input.userId, principalId: input.userId } : {}),
    ...(input.tokenType ? { clineTokenType: input.tokenType } : {}),
    oidcIssuer: "https://api.cline.bot",
    oidcClientId: CLINE_WORKOS_CLIENT_ID,
  }
}

function parseExpiresAt(expiresAt: unknown): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt
  if (typeof expiresAt === "string") {
    const ms = Date.parse(expiresAt)
    if (!Number.isNaN(ms)) return ms
  }
  // Default ~1h if server omitted expiresAt
  return Date.now() + 3600_000
}

/** Map Cline `/auth/register` or `/auth/refresh` envelope into a credential write. */
export function buildClinepassOAuthFromClineResponse(
  data: Record<string, unknown>,
  fallbackRefresh?: string,
): OAuthLoginBuildResult {
  const accessToken = str(data.accessToken)
  const refreshToken = str(data.refreshToken) ?? fallbackRefresh
  if (!accessToken) throw new Error("ClinePass OAuth: response missing accessToken")
  if (!refreshToken) throw new Error("ClinePass OAuth: response missing refreshToken")

  const userInfo =
    data.userInfo && typeof data.userInfo === "object"
      ? (data.userInfo as Record<string, unknown>)
      : {}
  const email = str(userInfo.email)
  const userId = str(userInfo.clineUserId) ?? str(userInfo.subject)
  const expiresAt = parseExpiresAt(data.expiresAt)
  const tokenType = str(data.tokenType) ?? "Bearer"

  const secrets = clinepassOAuthToSecrets({
    accessToken,
    refreshToken,
    expiresAt,
    email,
    userId,
    tokenType,
  })

  return {
    credential: {
      serviceId: CLINEPASS_OAUTH.serviceId,
      displayName: CLINEPASS_OAUTH.displayName,
      secrets,
    },
    result: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: [],
      ...(userId || email
        ? {
            account: {
              uuid: userId ?? "unknown",
              emailAddress: email ?? "unknown",
            },
          }
        : {}),
    },
  }
}

/** Host contract: buildCredential from a generic token-response bag (PKCE path). */
export function buildClinepassOAuthCredential(
  response: Record<string, unknown>,
): OAuthLoginBuildResult {
  // Accept either Cline envelope data fields or raw OAuth-style snake_case.
  if (str(response.accessToken)) {
    return buildClinepassOAuthFromClineResponse(response)
  }
  const accessToken = str(response.access_token)
  const refreshToken = str(response.refresh_token)
  if (!accessToken || !refreshToken) {
    throw new Error("ClinePass OAuth: unexpected token response shape")
  }
  const expiresIn = num(response.expires_in) ?? 3600
  return buildClinepassOAuthFromClineResponse({
    accessToken,
    refreshToken,
    tokenType: str(response.token_type) ?? "Bearer",
    expiresAt: Date.now() + expiresIn * 1000,
  })
}

/**
 * Cline's gateway expects account OAuth access tokens as
 * `Authorization: Bearer workos:<jwt>`. Bare JWTs 401 with
 * "re-authenticate your Cline account". API keys (`sk_…`) do not use this
 * prefix. Applied at readAuth time so every chat/account call is correct.
 */
export function formatClinepassBearerToken(accessToken: string): string {
  const t = accessToken.trim()
  if (!t) return t
  if (t.startsWith("workos:") || t.startsWith("sk_")) return t
  return `workos:${t}`
}

/** Decode stored OAuth secrets into runtime ProviderAuth for chat requests. */
export function readClinepassOAuthAuth(secrets: AuthSecretBag): ProviderAuth | null {
  const accessToken = str(secrets.accessToken)
  if (!accessToken) return null
  return {
    kind: "oauth",
    token: formatClinepassBearerToken(accessToken),
    baseUrl: CLINE_OPENAI_BASE,
    headers: { ...CLINEPASS_DEFAULT_HEADERS },
  }
}

/** Safe diagnostics for a stored OAuth credential. */
export function inspectClinepassOAuthCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const token = str(secrets.accessToken)
  const exp = num(secrets.expiresAt)
  return {
    usable: Boolean(token && token.length > 0),
    ...(exp ? { expiresAt: exp } : {}),
  }
}

async function requestClinepassDeviceCode(
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthDeviceCodeChallenge> {
  const body = new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID })
  const response = await network(ctx).request({
    label: "clinepass.oauth.device.code",
    method: "POST",
    url: WORKOS_DEVICE_AUTHORIZATION_URL,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED DEVICE CODE BODY]", responseBody: false },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`ClinePass device-code request failed (${response.status}): ${text}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  const deviceCode = str(raw.device_code)
  const userCode = str(raw.user_code)
  const verificationUri =
    str(raw.verification_uri_complete) ??
    str(raw.verification_uri) ??
    "https://auth.workos.com/user_management/device"
  const interval = num(raw.interval) ?? 5
  const expiresIn = num(raw.expires_in) ?? 300
  if (!deviceCode || !userCode) {
    throw new Error("ClinePass device-code response missing device_code or user_code")
  }
  // Harness validates user_code ≈ [A-Z0-9-]+
  const normalizedUserCode = userCode.replace(/\s+/g, "-").toUpperCase()
  if (!/^[A-Z0-9-]+$/i.test(normalizedUserCode)) {
    throw new Error(`ClinePass device-code invalid user_code format: ${userCode}`)
  }
  return {
    verificationUrl: verificationUri,
    userCode: normalizedUserCode,
    pollIntervalMs: interval * 1000,
    expiresInMs: expiresIn * 1000,
    providerData: { deviceCode, rawUserCode: userCode },
  }
}

async function registerWorkOSWithCline(
  workos: { accessToken: string; refreshToken: string },
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthLoginBuildResult> {
  const response = await network(ctx).request({
    label: "clinepass.oauth.register",
    method: "POST",
    url: CLINE_AUTH.register,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...CLINEPASS_DEFAULT_HEADERS,
    },
    body: JSON.stringify({
      accessToken: workos.accessToken,
      refreshToken: workos.refreshToken,
    }),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED REGISTER BODY]", responseBody: false },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`ClinePass token registration failed (${response.status}): ${text}`)
  }
  const json = await response.json<{
    success?: boolean
    data?: Record<string, unknown>
  }>()
  if (!json.success || !json.data) {
    throw new Error("ClinePass token registration returned unsuccessful envelope")
  }
  return buildClinepassOAuthFromClineResponse(json.data)
}

async function completeClinepassDeviceCode(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthLoginBuildResult> {
  const deviceCode = str(challenge.providerData?.deviceCode)
  if (!deviceCode) throw new Error("ClinePass device-code challenge missing device_code")

  const started = Date.now()
  const timeout = challenge.expiresInMs ?? DEFAULT_TIMEOUT_MS
  let intervalMs = challenge.pollIntervalMs ?? DEFAULT_POLL_MS

  for (;;) {
    throwIfAborted(ctx.signal)
    if (Date.now() - started > timeout) {
      throw new Error("ClinePass device code expired. Run login again.")
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLINE_WORKOS_CLIENT_ID,
    })
    const response = await network(ctx).request({
      label: "clinepass.oauth.device.poll",
      method: "POST",
      url: WORKOS_AUTHENTICATE_URL,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: ctx.signal,
      capture: { requestBody: "[REDACTED DEVICE POLL BODY]", responseBody: false },
    })

    if (response.ok) {
      const tokens = await response.json<Record<string, unknown>>()
      const accessToken = str(tokens.access_token)
      const refreshToken = str(tokens.refresh_token)
      if (!accessToken || !refreshToken) {
        throw new Error("ClinePass WorkOS token response missing access/refresh")
      }
      return registerWorkOSWithCline({ accessToken, refreshToken }, ctx)
    }

    let errBody: Record<string, unknown> = {}
    try {
      errBody = await response.json<Record<string, unknown>>()
    } catch {
      const text = await response.text()
      throw new Error(`ClinePass device-code poll failed (${response.status}): ${text}`)
    }
    const err = str(errBody.error)
    if (err === "authorization_pending") {
      await delay(intervalMs, ctx.signal)
      continue
    }
    if (err === "slow_down") {
      intervalMs += 1000
      await delay(intervalMs, ctx.signal)
      continue
    }
    if (err === "expired_token") {
      throw new Error("ClinePass device code expired. Run login again.")
    }
    if (err === "access_denied") {
      throw new Error("ClinePass authorization denied (user rejected the request).")
    }
    throw new Error(`ClinePass device-code poll error: ${JSON.stringify(errBody)}`)
  }
}

/** Refresh via Cline `/api/v1/auth/refresh`. */
export async function refreshClinepassOAuthCredential(
  secrets: AuthSecretBag,
  ctx: OAuthCredentialRefreshContext,
): Promise<OAuthLoginBuildResult> {
  const refreshToken = str(secrets.refreshToken)
  if (!refreshToken) throw new Error("ClinePass OAuth credential has no refresh token")

  const response = await network(ctx).request({
    label: "clinepass.oauth.refresh",
    method: "POST",
    url: CLINE_AUTH.refresh,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...CLINEPASS_DEFAULT_HEADERS,
    },
    body: JSON.stringify({
      refreshToken,
      grantType: "refresh_token",
    }),
    // OAuthCredentialRefreshContext may not expose signal on all host versions.
    signal: (ctx as { signal?: AbortSignal }).signal,
    capture: { requestBody: "[REDACTED OAUTH REFRESH BODY]", responseBody: false },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`ClinePass OAuth refresh failed (${response.status}): ${text}`)
  }
  const json = await response.json<{
    success?: boolean
    data?: Record<string, unknown>
  }>()
  if (!json.success || !json.data) {
    throw new Error("ClinePass OAuth refresh returned unsuccessful envelope")
  }
  return buildClinepassOAuthFromClineResponse(json.data, refreshToken)
}

export const clinepassOAuthLogin: OAuthLoginProvider = {
  ...CLINEPASS_OAUTH,
  config: clinepassOAuthConfig,
  deviceCode: {
    request: requestClinepassDeviceCode,
    complete: completeClinepassDeviceCode,
  },
  buildCredential: buildClinepassOAuthCredential,
  readAuth: readClinepassOAuthAuth,
  inspectCredential: inspectClinepassOAuthCredential,
  refreshCredential: refreshClinepassOAuthCredential,
}
