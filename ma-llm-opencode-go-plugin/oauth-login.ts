/**
 * OpenCode Console device OAuth (client `opencode-cli`).
 *
 * Same flow as the official client (`packages/core/src/plugin/provider/opencode.ts`):
 *   POST `{server}/auth/device/code`, returns user_code + verification_uri_complete
 *   poll POST `{server}/auth/device/token` (device_code grant)
 *   GET  `{server}/api/user` and `{server}/api/orgs` with the new token
 *   refresh: POST `{server}/auth/device/token` (refresh_token grant, both rotate)
 *
 * One Console token serves OpenCode Zen and OpenCode Go, so both plugins use
 * the same serviceId and secret shape.
 *
 * @module oauth-login
 */
import { ProviderError } from "./lib/errors.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
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
import { opencodeUserAgent } from "./opencode-identity.ts"

export const OPENCODE_CONSOLE_OAUTH = {
  serviceId: "opencode-console-oauth",
  displayName: "OpenCode Console",
} as const

export const OPENCODE_CONSOLE_SERVER = "https://opencode.ai/console"
export const OPENCODE_CONSOLE_CLIENT_ID = "opencode-cli"
export const OPENCODE_LOGIN_HINT = "run: ma provider opencode-go login"

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const DEFAULT_EXPIRES_MS = 600_000
const DEFAULT_INTERVAL_MS = 5_000
/** Added to the poll interval on `slow_down`. */
export const SLOW_DOWN_STEP_MS = 5_000
const REQUEST_TIMEOUT_MS = 15_000
/** Token lifetime used when the server omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 3_600

/** Profile fields saved next to the tokens. */
export interface OpencodeConsoleProfile {
  server?: string
  accountID?: string
  email?: string
  orgID?: string
  orgName?: string
}

/** Test seam: replace the poll wait. */
export interface OpencodeDeviceDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function network(ctx: OAuthDeviceCodeContext | OAuthCredentialRefreshContext): NetworkClient {
  const client = ctx.networkClient as NetworkClient | undefined
  if (!client) throw new Error("OpenCode Console OAuth: missing network client")
  return client
}

function abortError(): Error {
  const err = new Error("OpenCode Console OAuth aborted")
  err.name = "AbortError"
  return err
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function readJson(response: NetworkResponse): Promise<Record<string, unknown> | undefined> {
  const text = await response.text()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function consoleHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/json",
    "user-agent": opencodeUserAgent(),
    ...extra,
  }
}

function normalizeServer(server: string | undefined): string {
  return (server ?? OPENCODE_CONSOLE_SERVER).replace(/\/+$/, "")
}

/** Dummy PKCE config. The host requires `config()`; this provider uses the device flow. */
export function opencodeConsoleOAuthConfig(): OAuthLoginConfig {
  return {
    clientId: OPENCODE_CONSOLE_CLIENT_ID,
    authorizeUrl: `${OPENCODE_CONSOLE_SERVER}/auth/device/code`,
    tokenUrl: `${OPENCODE_CONSOLE_SERVER}/auth/device/token`,
    redirectUri: "http://127.0.0.1/callback",
    scopes: [],
    tokenRequestEncoding: "json",
  }
}

/** Encode a token response plus profile into the host secret bag. */
export function opencodeOAuthToSecrets(
  raw: Record<string, unknown>,
  profile: OpencodeConsoleProfile = {},
): AuthSecretBag {
  const accessToken = str(raw.access_token)
  const refreshToken = str(raw.refresh_token)
  if (!accessToken) throw new Error("OpenCode Console OAuth response missing access_token")
  const expiresIn = num(raw.expires_in) ?? DEFAULT_TOKEN_LIFETIME_S
  const secrets: AuthSecretBag = {
    tokenType: "oauth",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    server: normalizeServer(profile.server),
  }
  if (profile.accountID) secrets.accountID = profile.accountID
  if (profile.email) secrets.email = profile.email
  if (profile.orgID) secrets.orgID = profile.orgID
  if (profile.orgName) secrets.orgName = profile.orgName
  return secrets
}

/** Build the host credential write from a token response and profile. */
export function buildOpencodeOAuthCredential(
  response: Record<string, unknown>,
  profile?: OpencodeConsoleProfile,
): OAuthLoginBuildResult {
  const secrets = opencodeOAuthToSecrets(response, profile)
  const accountID = str(secrets.accountID)
  const orgID = str(secrets.orgID)
  return {
    credential: {
      serviceId: OPENCODE_CONSOLE_OAUTH.serviceId,
      displayName: OPENCODE_CONSOLE_OAUTH.displayName,
      secrets,
    },
    result: {
      accessToken: String(secrets.accessToken),
      refreshToken: str(secrets.refreshToken) ?? "",
      expiresAt: Number(secrets.expiresAt),
      scopes: [],
      ...(accountID
        ? { account: { uuid: accountID, emailAddress: str(secrets.email) ?? "unknown" } }
        : {}),
      ...(orgID ? { organization: { uuid: orgID } } : {}),
    },
  }
}

/** Decode stored secrets into runtime auth. Adds `x-org-id` when an org exists. */
export function readOpencodeOAuthAuth(secrets: AuthSecretBag): ProviderAuth | null {
  const token = str(secrets.accessToken)
  if (!token) return null
  const orgID = str(secrets.orgID)
  return orgID ? { kind: "oauth", token, headers: { "x-org-id": orgID } } : { kind: "oauth", token }
}

/** Safe diagnostics for a stored Console credential. */
export function inspectOpencodeOAuthCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const expiresAt = num(secrets.expiresAt)
  const email = str(secrets.email)
  const orgID = str(secrets.orgID)
  const labelParts = [email, str(secrets.orgName)].filter(Boolean)
  return {
    usable: Boolean(str(secrets.accessToken)),
    hasRefreshToken: Boolean(str(secrets.refreshToken)),
    ...(expiresAt ? { expiresAt } : {}),
    ...(email ? { accountId: email } : {}),
    ...(orgID ? { organizationId: orgID } : {}),
    ...(labelParts.length > 0 ? { label: labelParts.join(" · ") } : {}),
  }
}

/** Step 1: ask the Console for a device code. */
export async function requestOpencodeDeviceCode(
  ctx: OAuthDeviceCodeContext,
  server: string = OPENCODE_CONSOLE_SERVER,
): Promise<OAuthDeviceCodeChallenge> {
  const base = normalizeServer(server)
  const response = await network(ctx).request({
    label: "opencode.oauth.device.code",
    method: "POST",
    url: `${base}/auth/device/code`,
    headers: consoleHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ client_id: OPENCODE_CONSOLE_CLIENT_ID, supports_org_scope: true }),
    signal: ctx.signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    capture: { responseBody: false },
  })
  if (!response.ok) {
    throw new Error(
      `OpenCode device-code request failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    )
  }
  const raw = (await readJson(response)) ?? {}
  const deviceCode = str(raw.device_code)
  const userCode = str(raw.user_code)
  const verification = str(raw.verification_uri_complete)
  if (!deviceCode || !userCode || !verification)
    throw new Error("OpenCode device-code response missing device_code, user_code, or URL")
  const url = new URL(verification, `${base}/`)
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`OpenCode device-code URL is not http(s): ${url.href}`)
  return {
    verificationUrl: url.href,
    userCode,
    pollIntervalMs: (num(raw.interval) ?? DEFAULT_INTERVAL_MS / 1000) * 1000,
    expiresInMs: (num(raw.expires_in) ?? DEFAULT_EXPIRES_MS / 1000) * 1000,
    providerData: { deviceCode, server: base },
  }
}

async function getJson(
  client: NetworkClient,
  url: string,
  token: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json: unknown; text?: string }> {
  const response = await client.request({
    label,
    method: "GET",
    url,
    headers: consoleHeaders({ authorization: `Bearer ${token}` }),
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { ok: response.ok, status: response.status, json, text }
}

/** Pick the org: token `org_id` when set, else first by name then id. */
export function pickOpencodeOrg(
  orgs: ReadonlyArray<{ id: string; name: string }>,
  orgId: string | null | undefined,
): { id: string; name: string } | undefined {
  if (orgId == null)
    return [...orgs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
  return orgs.find((org) => org.id === orgId)
}

/** Step 2 and 3: poll for the token, then read user and orgs. */
export async function completeOpencodeDeviceCode(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
  deps: OpencodeDeviceDeps = {},
): Promise<OAuthLoginBuildResult> {
  const deviceCode = str(challenge.providerData?.deviceCode)
  if (!deviceCode) throw new Error("OpenCode device-code challenge missing device_code")
  const server = normalizeServer(str(challenge.providerData?.server))
  const sleep = deps.sleep ?? delay
  const client = network(ctx)
  const deadline = Date.now() + (challenge.expiresInMs ?? DEFAULT_EXPIRES_MS)
  let wait = challenge.pollIntervalMs ?? DEFAULT_INTERVAL_MS

  while (Date.now() < deadline) {
    await sleep(wait, ctx.signal)
    if (ctx.signal?.aborted) throw abortError()
    const response = await client.request({
      label: "opencode.oauth.device.poll",
      method: "POST",
      url: `${server}/auth/device/token`,
      headers: consoleHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: OPENCODE_CONSOLE_CLIENT_ID,
      }),
      signal: ctx.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      capture: { requestBody: "[REDACTED DEVICE POLL BODY]", responseBody: false },
    })
    // The official client does not check the poll status: the body is a token or {error}.
    const json = (await readJson(response)) ?? {}
    if (str(json.access_token)) {
      const token = str(json.access_token) as string
      const [user, orgs] = await Promise.all([
        getJson(client, `${server}/api/user`, token, "opencode.oauth.user", ctx.signal),
        getJson(client, `${server}/api/orgs`, token, "opencode.oauth.orgs", ctx.signal),
      ])
      if (!user.ok)
        throw new Error(`OpenCode user fetch failed (${user.status}): ${user.text?.slice(0, 200)}`)
      const userJson = (user.json ?? {}) as Record<string, unknown>
      const list = Array.isArray(orgs.json)
        ? (orgs.json as Array<{ id: string; name: string }>)
        : []
      const tokenOrg = str(json.org_id)
      const org = pickOpencodeOrg(list, tokenOrg ?? null)
      return buildOpencodeOAuthCredential(json, {
        server,
        accountID: str(userJson.id),
        email: str(userJson.email),
        orgID: org?.id ?? tokenOrg,
        orgName: org?.name,
      })
    }
    const error = str(json.error)
    // A transient gateway failure (5xx, no OAuth error field): keep polling.
    if (!error && response.status >= 500) continue
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      wait += SLOW_DOWN_STEP_MS
      continue
    }
    throw new Error(`OpenCode device-code poll failed: ${JSON.stringify(json).slice(0, 300)}`)
  }
  throw new Error("OpenCode device code expired. Run login again.")
}

/** Refresh the Console token. Both tokens rotate. `invalid_grant` means signed out. */
export async function refreshOpencodeOAuthCredential(
  secrets: AuthSecretBag,
  ctx: OAuthCredentialRefreshContext,
): Promise<OAuthLoginBuildResult> {
  const refreshToken = str(secrets.refreshToken)
  if (!refreshToken)
    throw new ProviderError("OpenCode Console credential has no refresh token", "opencode-go", {
      status: 401,
      retryable: false,
      code: "opencode.signed_out",
      hint: OPENCODE_LOGIN_HINT,
    })
  const server = normalizeServer(str(secrets.server))
  const response = await network(ctx).request({
    label: "opencode.oauth.refresh",
    method: "POST",
    url: `${server}/auth/device/token`,
    headers: consoleHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENCODE_CONSOLE_CLIENT_ID,
    }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    capture: { requestBody: "[REDACTED OAUTH REFRESH BODY]", responseBody: false },
  })
  const json = (await readJson(response)) ?? {}
  if (!response.ok || !str(json.access_token)) {
    if (str(json.error) === "invalid_grant")
      throw new ProviderError(
        "OpenCode Console sign-in expired (invalid_grant). Reconnect OpenCode Console to continue.",
        "opencode-go",
        {
          status: 401,
          retryable: false,
          upstreamCode: "invalid_grant",
          code: "opencode.signed_out",
          hint: OPENCODE_LOGIN_HINT,
        },
      )
    throw new Error(
      `OpenCode Console refresh failed (${response.status}): ${JSON.stringify(json).slice(0, 300)}`,
    )
  }
  const priorOrg = str(secrets.orgID)
  const newOrg = str(json.org_id)
  const orgID = newOrg ?? priorOrg
  // A new org id has no known name until the next login; never store the id as the name.
  const orgName = newOrg && newOrg !== priorOrg ? undefined : str(secrets.orgName)
  // Keep the old refresh token if the server did not rotate it.
  const tokens = str(json.refresh_token) ? json : { ...json, refresh_token: refreshToken }
  return buildOpencodeOAuthCredential(tokens, {
    server,
    accountID: str(secrets.accountID),
    email: str(secrets.email),
    orgID,
    orgName,
  })
}

export const opencodeConsoleOAuthLogin: OAuthLoginProvider = {
  ...OPENCODE_CONSOLE_OAUTH,
  config: opencodeConsoleOAuthConfig,
  deviceCode: {
    request: (ctx) => requestOpencodeDeviceCode(ctx),
    complete: (challenge, ctx) => completeOpencodeDeviceCode(challenge, ctx),
  },
  buildCredential: (response) => buildOpencodeOAuthCredential(response),
  readAuth: readOpencodeOAuthAuth,
  inspectCredential: inspectOpencodeOAuthCredential,
  refreshCredential: refreshOpencodeOAuthCredential,
}
