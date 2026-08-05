/**
 * Grok / xAI OIDC login — device-code (PIN) preferred, PKCE config available.
 *
 * Mirrors host contract used by OpenAI (`deviceCode` on OAuthLoginProvider)
 * and endpoints proven against auth.x.ai (see grok/api research).
 *
 * Device flow (no localhost callback):
 *   POST `\{issuer\}/oauth2/device/code`
 *   → user_code (PIN) + verification_uri
 *   poll POST `\{issuer\}/oauth2/token` grant_type=device_code
 *
 * @module llm/providers/grok/oauth-login
 */

import {
  applyGrokAccountProfile,
  fetchGrokAccountProfile,
  type GrokAccountProfile,
  grokAccountProfileHasData,
  preserveGrokAccountProfileSecrets,
} from "./account-profile.ts"
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
import { CLI_CHAT_PROXY_BASE_URL } from "./wire-constants.ts"

export const GROK_OAUTH = {
  serviceId: "grok-oauth",
  displayName: "Grok / xAI (OAuth)",
} as const

/** Public native-app client id used by Grok Build CLI (PKCE, no secret). */
export const GROK_OIDC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const GROK_OIDC_ISSUER = "https://auth.x.ai"
export const GROK_OIDC_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
] as const

const DEVICE_CODE_URL = `${GROK_OIDC_ISSUER}/oauth2/device/code`
const TOKEN_URL = `${GROK_OIDC_ISSUER}/oauth2/token`
const AUTHORIZE_URL = `${GROK_OIDC_ISSUER}/oauth2/authorize`
const DEFAULT_REDIRECT = "http://127.0.0.1/callback"
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function network(ctx: OAuthDeviceCodeContext | OAuthCredentialRefreshContext): NetworkClient {
  const client = ctx.networkClient as NetworkClient | undefined
  if (!client) throw new Error("Grok OAuth: missing network client")
  return client
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error("Grok OAuth aborted")
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
      const err = new Error("Grok OAuth aborted")
      err.name = "AbortError"
      reject(err)
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".")
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Build the host PKCE/OAuth config for Grok / xAI. */
export function grokOAuthConfig(): OAuthLoginConfig {
  return {
    clientId: GROK_OIDC_CLIENT_ID,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    redirectUri: DEFAULT_REDIRECT,
    scopes: [...GROK_OIDC_SCOPES],
    tokenRequestEncoding: "form",
    tokenRequestIncludesState: true,
  }
}

/** Encode token endpoint JSON into the host secret bag. */
export function grokOAuthToSecrets(
  raw: Record<string, unknown>,
  profile?: GrokAccountProfile,
): AuthSecretBag {
  const accessToken = str(raw.access_token)
  const refreshToken = str(raw.refresh_token)
  if (!accessToken) throw new Error("Grok OAuth response missing access_token")

  const expiresIn = num(raw.expires_in) ?? 21_600
  const expiresAt = Date.now() + expiresIn * 1000
  const payload = decodeJwtPayload(accessToken) ?? {}
  const sub = str(payload.sub)
  const principalId = str(payload.principal_id) ?? sub
  const teamId = str(payload.team_id)
  const scope = str(raw.scope) ?? str(payload.scope)
  const jwtTier = num(payload.tier)

  const secrets: AuthSecretBag = {
    tokenType: "oauth",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt,
    oidcIssuer: GROK_OIDC_ISSUER,
    oidcClientId: GROK_OIDC_CLIENT_ID,
    ...(sub ? { userId: sub } : {}),
    ...(principalId ? { principalId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(scope ? { scope } : {}),
    ...(jwtTier !== undefined ? { jwtTier } : {}),
  }
  if (profile) applyGrokAccountProfile(secrets, profile)
  return secrets
}

function accountEmailFromSecrets(secrets: AuthSecretBag): string {
  return str(secrets.emailAddress) ?? "unknown"
}

/** Convert a raw token response into a host-persistable credential write. */
export function buildGrokOAuthCredential(
  response: Record<string, unknown>,
  profile?: GrokAccountProfile,
): OAuthLoginBuildResult {
  const secrets = grokOAuthToSecrets(response, profile)
  const accessToken = String(secrets.accessToken)
  const refreshToken = typeof secrets.refreshToken === "string" ? secrets.refreshToken : ""
  return {
    credential: {
      serviceId: GROK_OAUTH.serviceId,
      displayName: GROK_OAUTH.displayName,
      secrets,
    },
    result: {
      accessToken,
      refreshToken,
      expiresAt: Number(secrets.expiresAt),
      scopes: String(secrets.scope ?? "")
        .split(/\s+/)
        .filter(Boolean),
      ...(typeof secrets.userId === "string"
        ? {
            account: {
              uuid: secrets.userId,
              emailAddress: accountEmailFromSecrets(secrets),
            },
          }
        : {}),
    },
  }
}

/**
 * After a token response, enrich secrets with userinfo / session / subscriptions.
 * Best-effort: on failure, keep any prior profile fields from `priorSecrets`.
 */
export async function finalizeGrokOAuthCredential(
  response: Record<string, unknown>,
  ctx: OAuthDeviceCodeContext | OAuthCredentialRefreshContext,
  priorSecrets?: AuthSecretBag,
): Promise<OAuthLoginBuildResult> {
  const built = buildGrokOAuthCredential(response)
  preserveGrokAccountProfileSecrets(built.credential.secrets, priorSecrets)

  const accessToken = str(built.credential.secrets.accessToken)
  if (!accessToken) return built

  try {
    const client = network(ctx)
    const profile = await fetchGrokAccountProfile(client, accessToken, ctx.signal)
    if (grokAccountProfileHasData(profile)) {
      applyGrokAccountProfile(built.credential.secrets, profile)
      if (built.result.account && typeof built.credential.secrets.emailAddress === "string") {
        built.result.account.emailAddress = built.credential.secrets.emailAddress
      } else if (
        typeof built.credential.secrets.userId === "string" &&
        typeof built.credential.secrets.emailAddress === "string"
      ) {
        built.result.account = {
          uuid: built.credential.secrets.userId,
          emailAddress: built.credential.secrets.emailAddress,
        }
      }
    }
  } catch {
    // keep tokens + any preserved prior profile fields
  }
  return built
}

/** Decode a stored Grok OAuth secret bag into runtime provider auth. */
export function readGrokOAuthAuth(secrets: AuthSecretBag): ProviderAuth | null {
  const accessToken = str(secrets.accessToken)
  if (!accessToken) return null
  return {
    kind: "oauth",
    token: accessToken,
    // Route OAuth sessions to cli-chat-proxy (subscription inference).
    baseUrl: `${CLI_CHAT_PROXY_BASE_URL}/v1`,
    headers: {
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
    },
  }
}

/** Safe diagnostics for a stored Grok OAuth credential bag. */
export function inspectGrokOAuthCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const token = str(secrets.accessToken)
  const exp = num(secrets.expiresAt)
  const email = str(secrets.emailAddress)
  const userId = str(secrets.userId)
  const plan = str(secrets.plan)
  const planStatus = str(secrets.planStatus)
  const labelParts = [email, plan, planStatus].filter(Boolean)
  const accountId = email ?? userId
  return {
    usable: Boolean(token && token.length > 0),
    hasRefreshToken: Boolean(str(secrets.refreshToken)),
    ...(exp ? { expiresAt: exp } : {}),
    ...(accountId ? { accountId } : {}),
    ...(str(secrets.teamId) ? { organizationId: str(secrets.teamId) } : {}),
    ...(labelParts.length > 0 ? { label: labelParts.join(" · ") } : {}),
  }
}

async function requestGrokDeviceCode(
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthDeviceCodeChallenge> {
  const body = new URLSearchParams({
    client_id: GROK_OIDC_CLIENT_ID,
    scope: GROK_OIDC_SCOPES.join(" "),
  })
  const response = await network(ctx).request({
    label: "grok.oauth.device.code",
    method: "POST",
    url: DEVICE_CODE_URL,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "x-grok-client-surface": "grok-build",
    },
    body: body.toString(),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED DEVICE CODE BODY]", responseBody: false },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Grok device-code request failed (${response.status}): ${text}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  const deviceCode = str(raw.device_code)
  const userCode = str(raw.user_code)
  const verificationUri =
    str(raw.verification_uri_complete) ??
    str(raw.verification_uri) ??
    "https://accounts.x.ai/oauth2/device"
  const interval = num(raw.interval) ?? 5
  const expiresIn = num(raw.expires_in) ?? 1800
  if (!deviceCode || !userCode) {
    throw new Error("Grok device-code response missing device_code or user_code")
  }
  // Harness validates user_code ≈ [A-Z0-9-]+
  if (!/^[A-Z0-9-]+$/i.test(userCode)) {
    throw new Error(`Grok device-code invalid user_code format: ${userCode}`)
  }
  return {
    verificationUrl: verificationUri,
    userCode,
    pollIntervalMs: interval * 1000,
    expiresInMs: expiresIn * 1000,
    providerData: { deviceCode },
  }
}

async function completeGrokDeviceCode(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthLoginBuildResult> {
  const deviceCode = str(challenge.providerData?.deviceCode)
  if (!deviceCode) throw new Error("Grok device-code challenge missing device_code")

  const started = Date.now()
  const timeout = challenge.expiresInMs ?? DEFAULT_TIMEOUT_MS
  let intervalMs = challenge.pollIntervalMs ?? 5000

  for (;;) {
    throwIfAborted(ctx.signal)
    if (Date.now() - started > timeout) {
      throw new Error("Grok device code expired. Run login again.")
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: GROK_OIDC_CLIENT_ID,
    })
    const response = await network(ctx).request({
      label: "grok.oauth.device.poll",
      method: "POST",
      url: TOKEN_URL,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "x-grok-client-surface": "grok-build",
      },
      body: body.toString(),
      signal: ctx.signal,
      capture: { requestBody: "[REDACTED DEVICE POLL BODY]", responseBody: false },
    })

    if (response.ok) {
      const tokens = await response.json<Record<string, unknown>>()
      return finalizeGrokOAuthCredential(tokens, ctx)
    }

    let errBody: Record<string, unknown> = {}
    try {
      errBody = await response.json<Record<string, unknown>>()
    } catch {
      const text = await response.text()
      throw new Error(`Grok device-code poll failed (${response.status}): ${text}`)
    }
    const err = str(errBody.error)
    if (err === "authorization_pending") {
      await delay(intervalMs, ctx.signal)
      continue
    }
    if (err === "slow_down") {
      intervalMs += 5000
      await delay(intervalMs, ctx.signal)
      continue
    }
    if (err === "expired_token") {
      throw new Error("Grok device code expired. Run login again.")
    }
    if (err === "access_denied") {
      throw new Error("Grok authorization denied (user rejected the request).")
    }
    throw new Error(`Grok device-code poll error: ${JSON.stringify(errBody)}`)
  }
}

/** Refresh a stored Grok OAuth credential via the OIDC token endpoint. */
export async function refreshGrokOAuthCredential(
  secrets: AuthSecretBag,
  ctx: OAuthCredentialRefreshContext,
): Promise<OAuthLoginBuildResult> {
  const refreshToken = str(secrets.refreshToken)
  if (!refreshToken) throw new Error("Grok OAuth credential has no refresh token")
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: GROK_OIDC_CLIENT_ID,
  })
  const response = await network(ctx).request({
    label: "grok.oauth.refresh",
    method: "POST",
    url: TOKEN_URL,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED OAUTH REFRESH BODY]", responseBody: false },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Grok OAuth refresh failed (${response.status}): ${text}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  return finalizeGrokOAuthCredential(
    {
      ...raw,
      refresh_token: str(raw.refresh_token) ?? refreshToken,
    },
    ctx,
    secrets,
  )
}

export const grokOAuthLogin: OAuthLoginProvider = {
  ...GROK_OAUTH,
  config: grokOAuthConfig,
  deviceCode: {
    request: requestGrokDeviceCode,
    complete: completeGrokDeviceCode,
  },
  buildCredential: buildGrokOAuthCredential,
  readAuth: readGrokOAuthAuth,
  inspectCredential: inspectGrokOAuthCredential,
  refreshCredential: refreshGrokOAuthCredential,
}
