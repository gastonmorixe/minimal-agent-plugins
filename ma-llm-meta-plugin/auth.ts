/**
 * Meta auth strategies: Model API key + Muse Code OAuth (device code).
 *
 * API keys: minted at https://dev.meta.ai/ (`LLM_…`), Bearer on api.meta.ai.
 * Muse Code: RFC 8628 device flow at auth.meta.com, then mint a Model API key
 * (Observed in Muse CLI binary: OAuthTokens + MintedKey).
 *
 * @module llm/providers/meta/auth
 */

import type { NetworkClient } from "./lib/net-types.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
  OAuthDeviceCodeChallenge,
  OAuthDeviceCodeContext,
  OAuthLoginProvider,
} from "./lib/provider-plugin.ts"
import {
  META_API_BASE_URL,
  META_OPENAI_BASE,
  MUSE_API_VERSION,
  MUSE_AUTH_BASE_URL,
  MUSE_CLIENT_ID,
  MUSE_CLIENT_ID_HEADER,
  MUSE_DEVICE_AUTHORIZATION_URL,
  MUSE_DEVICE_CODE_GRANT,
  MUSE_DEVICE_TOKEN_URL,
  MUSE_KEY_MINT_URL,
  MUSE_OAUTH_USER_AGENT,
} from "./wire-constants.ts"

export const META_API_KEY_AUTH = {
  serviceId: "meta-api-key",
  displayName: "Meta Model API Key",
} as const

export const META_MUSE_OAUTH = {
  serviceId: "meta-muse-oauth",
  displayName: "Muse Code (OAuth)",
} as const

const MUSE_OAUTH_HEADERS = {
  accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
  "user-agent": MUSE_OAUTH_USER_AGENT,
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function network(ctx: OAuthDeviceCodeContext): NetworkClient {
  const client = ctx.networkClient as NetworkClient | undefined
  if (!client) throw new Error("Muse Code device-code login: missing network client")
  return client
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error("Muse Code device-code login aborted")
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
      const err = new Error("Muse Code device-code login aborted")
      err.name = "AbortError"
      reject(err)
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function clampLifetimeSeconds(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : num(raw)
  if (n === undefined || !Number.isFinite(n)) return 900
  if (n < 60) return 60
  if (n > 1800) return 1800
  return n
}

function pollIntervalMs(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : num(raw)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return 5000
  return n * 1000
}

function httpsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  if (raw.startsWith("https://")) return raw
  if (raw.startsWith("http://")) return `https://${raw.slice("http://".length)}`
  return undefined
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".")
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function absoluteExpiryMs(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : num(raw)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  // Heuristic: values beyond year ~2001 in ms are already milliseconds.
  return n > 1e12 ? n : n * 1000
}

function tokenExpiryMs(accessToken: string, rawExpiresIn?: unknown, rawExpiresAt?: unknown): number {
  const absolute = absoluteExpiryMs(rawExpiresAt)
  if (absolute) return absolute
  const jwtExp = num(decodeJwtPayload(accessToken)?.exp)
  if (jwtExp) return jwtExp * 1000
  const seconds = typeof rawExpiresIn === "string" ? Number.parseInt(rawExpiresIn, 10) : num(rawExpiresIn)
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return Date.now() + seconds * 1000
  }
  return Date.now() + 60 * 60 * 1000
}

/** Encode a Meta API key into this provider's opaque secret bag. */
export function metaApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a Meta API key. */
export function buildMetaApiKeyCredential(apiKey: string) {
  return {
    serviceId: META_API_KEY_AUTH.serviceId,
    displayName: META_API_KEY_AUTH.displayName,
    secrets: metaApiKeyToSecrets(apiKey),
  }
}

/** Decode a Meta API key from this provider's opaque secret bag. */
export function readMetaApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored API-key metadata without exposing the secret. */
export function inspectMetaApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readMetaApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const metaApiKeyAuth: ApiKeyAuthProvider = {
  ...META_API_KEY_AUTH,
  buildCredential: buildMetaApiKeyCredential,
  readApiKey: readMetaApiKey,
  inspectCredential: inspectMetaApiKeyCredential,
}

/** Encode Muse Code OAuth + minted Model API key into the opaque secret bag. */
export function museOAuthToSecrets(raw: Record<string, unknown>): AuthSecretBag {
  const accessToken = str(raw.access_token)
  if (!accessToken) {
    throw new Error("Muse Code OAuth response missing access_token")
  }
  const refreshToken = str(raw.refresh_token)
  const tokenType = str(raw.token_type)
  const scope = str(raw.scope)
  const apiKey = str(raw.api_key)
  const apiBaseUrl = str(raw.api_base_url) ?? str(raw.base_url)
  const obtainedVia = str(raw.obtained_via)
  const userFullName = str(raw.user_full_name)
  const userEmail = str(raw.user_email)
  const subsTierId = str(raw.subs_tier_id)
  const subsTierName = str(raw.subs_tier_name)
  const isSubsActive = raw.is_subs_active
  return {
    tokenType: "oauth",
    accessToken,
    expiresAt: tokenExpiryMs(accessToken, raw.expires_in, raw.expires_at),
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenType ? { oauthTokenType: tokenType } : {}),
    ...(scope ? { scope } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(obtainedVia ? { obtainedVia } : {}),
    ...(userFullName ? { userFullName } : {}),
    ...(userEmail ? { emailAddress: userEmail } : {}),
    ...(subsTierId ? { subsTierId } : {}),
    ...(subsTierName ? { subsTierName } : {}),
    ...(typeof isSubsActive === "boolean" ? { isSubsActive } : {}),
  }
}

/** Build the host-persistable credential write for Muse Code OAuth. */
export function buildMuseOAuthCredential(response: Record<string, unknown>) {
  const secrets = museOAuthToSecrets(response)
  const email = typeof secrets.emailAddress === "string" ? secrets.emailAddress : undefined
  return {
    credential: {
      serviceId: META_MUSE_OAUTH.serviceId,
      displayName: META_MUSE_OAUTH.displayName,
      secrets,
    },
    result: {
      accessToken: String(secrets.accessToken),
      refreshToken: typeof secrets.refreshToken === "string" ? secrets.refreshToken : "",
      expiresAt: Number(secrets.expiresAt),
      scopes:
        typeof secrets.scope === "string"
          ? secrets.scope.split(/\s+/).filter(Boolean)
          : [],
      ...(email
        ? {
            account: {
              uuid: typeof secrets.subsTierId === "string" ? secrets.subsTierId : "meta-muse",
              emailAddress: email,
            },
          }
        : {}),
    },
  }
}

/**
 * Mint a Meta Model API key with the device OAuth access token.
 *
 * Muse CLI (Observed): after TokenGrant, KeyMintManager fetches MintedKey
 * (`api_key`, subscription fields). Path **Inferred**: `POST/GET`
 * `https://api.meta.ai/muse-code/key`.
 */
export async function mintMuseApiKey(
  accessToken: string,
  ctx: OAuthDeviceCodeContext,
): Promise<Record<string, unknown>> {
  const mintUrl = process.env.TBH_MINT_BASE_URL
    ? `${process.env.TBH_MINT_BASE_URL.replace(/\/$/, "")}/muse-code/key`
    : MUSE_KEY_MINT_URL

  const headers = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": MUSE_OAUTH_USER_AGENT,
    "x-api-version": MUSE_API_VERSION,
    "x-client-id": MUSE_CLIENT_ID_HEADER,
  }

  // Try POST first (mint/create), then GET (fetch existing) if POST is 405/404.
  const attempts: Array<{ method: "POST" | "GET"; body?: string }> = [
    { method: "POST", body: "{}" },
    { method: "GET" },
  ]

  let lastError = "mint failed"
  for (const attempt of attempts) {
    throwIfAborted(ctx.signal)
    const response = await network(ctx).request({
      label: `meta.muse.oauth.mint.${attempt.method.toLowerCase()}`,
      method: attempt.method,
      url: mintUrl,
      headers: {
        ...headers,
        ...(attempt.body ? { "content-type": "application/json" } : {}),
      },
      ...(attempt.body ? { body: attempt.body } : {}),
      signal: ctx.signal,
      capture: { requestBody: "[REDACTED MUSE MINT BODY]", responseBody: false },
    })

    const bodyText = await response.text()
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(bodyText) as unknown
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      }
    } catch {
      /* non-JSON */
    }

    if (response.ok) {
      const apiKey = str(raw.api_key)
      if (!apiKey) {
        throw new Error("Muse Code mint returned an empty api key")
      }
      return {
        ...raw,
        api_key: apiKey,
        api_base_url:
          str(raw.api_base_url) ?? str(raw.base_url) ?? META_OPENAI_BASE,
      }
    }

    lastError = `Muse Code mint failed (${response.status})${bodyText ? `: ${bodyText}` : ""}`
    if (response.status === 405 || response.status === 404) continue
    // Payment / onboarding errors should surface immediately.
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new Error(lastError)
    }
    if (attempt.method === "GET") break
  }
  throw new Error(lastError)
}

async function requestMuseDeviceCode(
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthDeviceCodeChallenge> {
  const fields = new URLSearchParams({ client_id: MUSE_CLIENT_ID })
  const response = await network(ctx).request({
    label: "meta.muse.oauth.device.authorization",
    method: "POST",
    url: MUSE_DEVICE_AUTHORIZATION_URL,
    headers: { ...MUSE_OAUTH_HEADERS },
    body: fields.toString(),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED MUSE DEVICE AUTHORIZATION BODY]", responseBody: false },
  })
  if (!response.ok) {
    const body = await response.text()
    if (response.status === 404) {
      throw new Error("Muse Code sign-in is not available yet (HTTP 404)")
    }
    throw new Error(`Muse Code device-code request failed (${response.status}): ${body}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  const deviceCode = str(raw.device_code)
  const userCode = str(raw.user_code)
  const verificationUrl =
    httpsUrl(str(raw.verification_uri_complete)) ?? httpsUrl(str(raw.verification_uri))
  if (!deviceCode || !userCode || !verificationUrl) {
    throw new Error(
      "Muse Code device-code response missing device_code, user_code, or verification_uri",
    )
  }
  const lifetimeSec = clampLifetimeSeconds(raw.expires_in)
  return {
    verificationUrl,
    userCode,
    pollIntervalMs: pollIntervalMs(raw.interval),
    expiresInMs: lifetimeSec * 1000,
    providerData: { deviceCode },
  }
}

async function completeMuseDeviceCodeLogin(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
) {
  const deviceCode = str(challenge.providerData?.deviceCode)
  if (!deviceCode) throw new Error("Muse Code device-code challenge missing device_code")

  const started = Date.now()
  const deadlineMs = challenge.expiresInMs ?? 900_000
  let intervalMs = challenge.pollIntervalMs ?? 5000

  for (;;) {
    throwIfAborted(ctx.signal)
    if (Date.now() - started >= deadlineMs) {
      throw new Error("Muse Code sign-in request expired before it was approved")
    }

    const fields = new URLSearchParams({
      grant_type: MUSE_DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: MUSE_CLIENT_ID,
    })
    const response = await network(ctx).request({
      label: "meta.muse.oauth.device.token",
      method: "POST",
      url: MUSE_DEVICE_TOKEN_URL,
      headers: { ...MUSE_OAUTH_HEADERS },
      body: fields.toString(),
      signal: ctx.signal,
      capture: { requestBody: "[REDACTED MUSE DEVICE TOKEN BODY]", responseBody: false },
    })

    if (response.status >= 300 && response.status < 400) {
      throw new Error("Muse Code sign-in service redirected the token request; not following it")
    }

    const bodyText = await response.text()
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(bodyText) as unknown
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      }
    } catch {
      /* non-JSON body */
    }

    if (response.ok) {
      const tokenRaw = raw
      const accessToken = str(tokenRaw.access_token)
      if (!accessToken) {
        throw new Error("Muse Code sign-in response carried no usable token")
      }
      const minted = await mintMuseApiKey(accessToken, ctx)
      return buildMuseOAuthCredential({
        ...tokenRaw,
        ...minted,
        obtained_via: str(minted.obtained_via) ?? "device_code",
      })
    }

    const error = str(raw.error)
    switch (error) {
      case "authorization_pending":
        await delay(intervalMs, ctx.signal)
        continue
      case "slow_down":
        intervalMs += 5000
        await delay(intervalMs, ctx.signal)
        continue
      case "access_denied":
        throw new Error("Muse Code sign-in request was denied")
      case "expired_token":
        throw new Error("Muse Code sign-in request expired before it was approved")
      default:
        throw new Error(
          `Muse Code device-code poll failed (${response.status})${error ? `: ${error}` : bodyText ? `: ${bodyText}` : ""}`,
        )
    }
  }
}

/** Decode stored Muse Code credentials into runtime provider auth. */
export function readMuseOAuthAuth(secrets: AuthSecretBag): ProviderAuth | null {
  // Muse CLI uses the minted Model API key for api.meta.ai (destination=external),
  // not the raw OIDC access token.
  const apiKey = str(secrets.apiKey)
  if (apiKey) {
    return { kind: "api-key", key: apiKey }
  }
  const accessToken = str(secrets.accessToken)
  if (!accessToken) return null
  return {
    kind: "oauth",
    token: accessToken,
    baseUrl: str(secrets.apiBaseUrl) ?? META_API_BASE_URL,
  }
}

/** Inspect stored Muse Code OAuth metadata without exposing bearer tokens. */
export function inspectMuseOAuthCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  return {
    usable: Boolean(str(secrets.apiKey) ?? str(secrets.accessToken)),
    expiresAt: num(secrets.expiresAt),
    hasRefreshToken: Boolean(str(secrets.refreshToken)),
    label: META_MUSE_OAUTH.displayName,
    accountId: str(secrets.emailAddress) ?? str(secrets.subsTierName),
  }
}

export const museOAuthLogin: OAuthLoginProvider = {
  ...META_MUSE_OAUTH,
  config() {
    return {
      clientId: MUSE_CLIENT_ID,
      // PKCE fields are unused when deviceCode is present; host still calls config().
      authorizeUrl: `${MUSE_AUTH_BASE_URL}/oidc/device/authorization/`,
      tokenUrl: MUSE_DEVICE_TOKEN_URL,
      redirectUri: `${MUSE_AUTH_BASE_URL}/`,
      scopes: [],
      tokenRequestEncoding: "form",
      tokenRequestIncludesState: false,
    }
  },
  deviceCode: {
    request: requestMuseDeviceCode,
    complete: completeMuseDeviceCodeLogin,
  },
  buildCredential: buildMuseOAuthCredential,
  readAuth: readMuseOAuthAuth,
  inspectCredential: inspectMuseOAuthCredential,
}
