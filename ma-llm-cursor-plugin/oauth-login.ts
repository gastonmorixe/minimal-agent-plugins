import { createHash, randomBytes, randomUUID } from "node:crypto"

import { exchangeCursorApiKey, parseCursorTokenPair } from "./auth.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type {
  AuthCredentialInfo,
  AuthSecretBag,
  OAuthCredentialRefreshContext,
  OAuthDeviceCodeChallenge,
  OAuthDeviceCodeContext,
  OAuthLoginBuildResult,
  OAuthLoginProvider,
} from "./lib/provider-plugin.ts"
import { CURSOR_API_BASE, CURSOR_AUTH_POLL_PATH, CURSOR_WEBSITE_URL } from "./wire-constants.ts"

export const CURSOR_OAUTH = {
  serviceId: "cursor-oauth",
  displayName: "Cursor (Browser Login)",
} as const

const POLL_ATTEMPTS = 150
const POLL_BASE_DELAY_MS = 1_000
const POLL_MAX_DELAY_MS = 10_000
const TOKEN_FALLBACK_LIFETIME_MS = 60 * 60 * 1_000

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function network(ctx: OAuthDeviceCodeContext): NetworkClient {
  const client = ctx.networkClient as NetworkClient | undefined
  if (!client) throw new Error("Cursor browser login: missing network client")
  return client
}

function abortError(): Error {
  const error = new Error("Cursor browser login aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
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
      reject(abortError())
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

/** Build a loginDeepControl challenge (uuid + verifier, no PIN). */
export function createCursorLoginChallenge(
  options: {
    verifierBytes?: Uint8Array
    uuid?: string
    websiteUrl?: string
    redirectTarget?: string
  } = {},
): OAuthDeviceCodeChallenge {
  const verifier = base64Url(options.verifierBytes ?? randomBytes(32))
  const challenge = base64Url(createHash("sha256").update(verifier).digest())
  const uuid = options.uuid ?? randomUUID()
  const loginUrl = new URL(
    "/loginDeepControl",
    (options.websiteUrl ?? CURSOR_WEBSITE_URL).replace(/\/$/, ""),
  )
  loginUrl.searchParams.set("challenge", challenge)
  loginUrl.searchParams.set("uuid", uuid)
  loginUrl.searchParams.set("mode", "login")
  loginUrl.searchParams.set("redirectTarget", options.redirectTarget ?? "cli")
  return {
    verificationUrl: loginUrl.toString(),
    // Cursor has no PIN. The host requires a display code, so use a safe public correlation id.
    userCode: uuid,
    expiresInMs: 25 * 60 * 1_000,
    pollIntervalMs: POLL_BASE_DELAY_MS,
    providerData: { uuid, verifier },
  }
}

/** Encode a Cursor OAuth token pair into the host secret bag. */
export function cursorOAuthToSecrets(raw: Record<string, unknown>): AuthSecretBag {
  const pair = parseCursorTokenPair(raw)
  return {
    tokenType: "oauth",
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt,
  }
}

/** Build the host credential write from a raw token response. */
export function buildCursorOAuthCredential(
  response: Record<string, unknown>,
): OAuthLoginBuildResult {
  const secrets = cursorOAuthToSecrets(response)
  return {
    credential: {
      serviceId: CURSOR_OAUTH.serviceId,
      displayName: CURSOR_OAUTH.displayName,
      secrets,
    },
    result: {
      accessToken: String(secrets.accessToken),
      refreshToken: String(secrets.refreshToken),
      expiresAt: num(secrets.expiresAt) ?? Date.now() + TOKEN_FALLBACK_LIFETIME_MS,
      scopes: [],
    },
  }
}

/** Decode stored OAuth secrets into runtime ProviderAuth. */
export function readCursorOAuthAuth(secrets: AuthSecretBag): ProviderAuth | null {
  const accessToken = str(secrets.accessToken)
  if (!accessToken) return null
  return { kind: "oauth", token: accessToken, baseUrl: CURSOR_API_BASE }
}

/** Safe OAuth credential metadata for auth-status diagnostics. */
export function inspectCursorOAuthCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  return {
    usable: Boolean(str(secrets.accessToken)),
    label: CURSOR_OAUTH.displayName,
    expiresAt: num(secrets.expiresAt),
    hasRefreshToken: Boolean(str(secrets.refreshToken)),
  }
}

/**
 * Refresh a Cursor OAuth credential bag for the host's 401 recovery path.
 *
 * Cursor has no public `/auth/refresh` grant. When the bag still carries an
 * API key (or one was persisted alongside tokens), re-run
 * `/auth/exchange_user_api_key`. Pure browser-login bags (access + refresh
 * only) cannot be renewed here — the host surfaces a re-login error.
 */
export async function refreshCursorOAuthCredential(
  secrets: AuthSecretBag,
  ctx: OAuthCredentialRefreshContext = {},
): Promise<OAuthLoginBuildResult> {
  const apiKey = str(secrets.apiKey)
  if (!apiKey) {
    throw new Error(
      "Cursor browser-login credentials cannot be refreshed automatically. " +
        "Run: minimal-agent provider cursor login",
    )
  }
  const pair = await exchangeCursorApiKey(apiKey, {
    networkClient: ctx.networkClient as NetworkClient | undefined,
    force: true,
  })
  const built = buildCursorOAuthCredential({
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
  })
  // Keep the API key in the bag so subsequent host refreshes can re-exchange.
  built.credential.secrets.apiKey = apiKey
  return built
}

/** Poll backoff delay for attempt index (exponential, capped). */
export function cursorPollDelayMs(attempt: number): number {
  return Math.min(POLL_BASE_DELAY_MS * 1.2 ** attempt, POLL_MAX_DELAY_MS)
}

/** Poll auth until tokens return or the challenge expires / aborts. */
export async function completeCursorLogin(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthLoginBuildResult> {
  const uuid = str(challenge.providerData?.uuid)
  const verifier = str(challenge.providerData?.verifier)
  if (!uuid || !verifier) throw new Error("Cursor login challenge missing uuid or verifier")

  // Build poll URL with secrets, but **never** pass it through NetworkClient:
  // host net-dbg / activity observers log `req.url` verbatim, and
  // `capture.requestBody` cannot redact query strings. Use raw fetch so the
  // PKCE verifier does not land in NET_DBG traces.
  const pollUrl = new URL(CURSOR_AUTH_POLL_PATH, CURSOR_API_BASE)
  pollUrl.searchParams.set("uuid", uuid)
  pollUrl.searchParams.set("verifier", verifier)
  let consecutiveErrors = 0

  // Require a network client on the context (host always provides one) even
  // though the secret poll itself uses fetch to avoid URL logging.
  network(ctx)

  const sleepMs = (attempt: number) =>
    typeof challenge.pollIntervalMs === "number"
      ? challenge.pollIntervalMs
      : cursorPollDelayMs(attempt)

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    throwIfAborted(ctx.signal)
    try {
      const response = await fetch(pollUrl.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctx.signal,
      })
      if (response.status === 404) {
        consecutiveErrors = 0
        await delay(sleepMs(attempt), ctx.signal)
        continue
      }
      if (!response.ok) {
        consecutiveErrors++
        if (consecutiveErrors >= 3) {
          throw new Error(
            `Cursor login polling failed after 3 errors (last status ${response.status})`,
          )
        }
        await delay(sleepMs(attempt), ctx.signal)
        continue
      }
      const raw = (await response.json()) as Record<string, unknown>
      return buildCursorOAuthCredential(raw)
    } catch (error) {
      if (ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw error
      if (error instanceof Error && error.message.startsWith("Cursor login polling failed"))
        throw error
      consecutiveErrors++
      if (consecutiveErrors >= 3) {
        // Generic message only — never interpolate error.message or attach cause
        // (fetch errors may embed the secret poll URL with verifier).
        // oxlint-disable-next-line eslint/preserve-caught-error -- security: cause may contain verifier URL
        throw new Error("Cursor login polling failed after 3 errors")
      }
      await delay(sleepMs(attempt), ctx.signal)
    }
  }
  throw new Error("Cursor browser login expired. Run login again.")
}

export const cursorOAuthLogin: OAuthLoginProvider = {
  ...CURSOR_OAUTH,
  // Device-code is the active path. These fields satisfy the generic PKCE fallback contract.
  config() {
    return {
      clientId: "cursor-cli",
      authorizeUrl: `${CURSOR_WEBSITE_URL}/loginDeepControl`,
      tokenUrl: `${CURSOR_API_BASE}${CURSOR_AUTH_POLL_PATH}`,
      redirectUri: "cursor://cli",
      scopes: [],
      tokenRequestIncludesState: false,
    }
  },
  deviceCode: {
    request: async () => createCursorLoginChallenge(),
    complete: completeCursorLogin,
  },
  buildCredential: buildCursorOAuthCredential,
  readAuth: readCursorOAuthAuth,
  inspectCredential: inspectCursorOAuthCredential,
  refreshCredential: refreshCursorOAuthCredential,
}
