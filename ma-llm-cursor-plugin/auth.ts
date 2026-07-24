import type { NetworkClient } from "./lib/net-types.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "./lib/provider-plugin.ts"
import { CURSOR_API_BASE, CURSOR_RPC_EXCHANGE_API_KEY_PATH } from "./wire-constants.ts"

export const CURSOR_API_KEY_AUTH = {
  serviceId: "cursor-api-key",
  displayName: "Cursor API Key",
} as const

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function decodeJwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
    const exp = record(JSON.parse(Buffer.from(padded, "base64").toString("utf8")))?.exp
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** Encode a Cursor API key into the host secret bag. */
export function cursorApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a pasted API key. */
export function buildCursorApiKeyCredential(apiKey: string) {
  return {
    serviceId: CURSOR_API_KEY_AUTH.serviceId,
    displayName: CURSOR_API_KEY_AUTH.displayName,
    secrets: cursorApiKeyToSecrets(apiKey),
  }
}

/** Read the stored API key from secrets, or null. */
export function readCursorApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Safe credential metadata for auth-status diagnostics. */
export function inspectCursorApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  return {
    usable: Boolean(readCursorApiKey(secrets)),
    label: CURSOR_API_KEY_AUTH.displayName,
  }
}

export const cursorApiKeyAuth: ApiKeyAuthProvider = {
  ...CURSOR_API_KEY_AUTH,
  buildCredential: buildCursorApiKeyCredential,
  readApiKey: readCursorApiKey,
  inspectCredential: inspectCursorApiKeyCredential,
}

export interface CursorTokenPair {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Parse access/refresh tokens from a Cursor auth JSON response. */
export function parseCursorTokenPair(raw: Record<string, unknown>): CursorTokenPair {
  const accessToken = str(raw.accessToken) ?? str(raw.access_token)
  const refreshToken = str(raw.refreshToken) ?? str(raw.refresh_token)
  if (!accessToken || !refreshToken) {
    throw new Error("Cursor auth response missing accessToken or refreshToken")
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: decodeJwtExpiry(accessToken) ?? Date.now() + 60 * 60 * 1000,
  }
}

/** Exchange a user API key for the short-lived bearer pair Cursor Connect accepts. */
export async function exchangeCursorApiKey(
  apiKey: string,
  options: {
    networkClient?: NetworkClient
    signal?: AbortSignal
    apiBase?: string
  } = {},
): Promise<CursorTokenPair> {
  const url = `${(options.apiBase ?? CURSOR_API_BASE).replace(/\/$/, "")}${CURSOR_RPC_EXCHANGE_API_KEY_PATH}`
  const client = options.networkClient
  let response: Response | Awaited<ReturnType<NetworkClient["request"]>>
  if (client) {
    response = await client.request({
      label: "cursor.auth.exchange-api-key",
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: options.signal,
      capture: {
        requestBody: "[REDACTED CURSOR API KEY EXCHANGE BODY]",
        responseBody: false,
      },
    })
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: options.signal,
    })
  }
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cursor API-key exchange failed (${response.status}): ${body}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  const parsed = record(raw)
  if (!parsed) throw new Error("Cursor API-key exchange returned a non-object response")
  return parseCursorTokenPair(parsed)
}

/** Resolve an access token for a provider call, exchanging API keys when necessary. */
export async function resolveCursorAccessToken(
  auth: ProviderAuth,
  options: { networkClient?: NetworkClient; signal?: AbortSignal; apiBase?: string } = {},
): Promise<string> {
  switch (auth.kind) {
    case "oauth":
      if (!auth.token) throw new Error("Cursor OAuth credential has no access token")
      return auth.token
    case "api-key":
      if (!auth.key) throw new Error("Cursor API-key credential is empty")
      return (await exchangeCursorApiKey(auth.key, options)).accessToken
    case "custom": {
      const authorization = auth.headers.authorization ?? auth.headers.Authorization
      const match = authorization?.match(/^Bearer\s+(.+)$/i)
      if (!match?.[1]) throw new Error("Cursor custom auth requires a Bearer authorization header")
      return match[1]
    }
  }
}
