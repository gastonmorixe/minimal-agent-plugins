/**
 * Device Authorization Grant (RFC 8628) login for the CLI — plain `fetch`
 * against the backend's better-auth device endpoints.
 *
 * ## Why plain fetch, not better-auth/client
 *
 * better-auth's `deviceAuthorizationClient` is a browser/cookie-oriented SDK; a
 * CLI doesn't have a cookie jar or a DOM. The device grant is a tiny, stable HTTP
 * protocol (RFC 8628): POST `/device/code`, then poll POST `/device/token`. Doing
 * it with `fetch` keeps this plugin dependency-free (no better-auth in the shared
 * node_modules), fully decoupled, and easy to mock in tests. The endpoint paths +
 * shapes were read from better-auth's own source
 * (plugins/device-authorization/routes.ts):
 *
 *   - POST `base`/device/code  — body has client_id + optional scope; the JSON
 *     response has device_code, user_code, verification_uri,
 *     verification_uri_complete?, expires_in, interval.
 *   - POST `base`/device/token — body has grant_type (the device_code URN),
 *     device_code, client_id; a 200 returns the session + user (the bearer token
 *     rides in the `set-auth-token` response header since the backend runs the
 *     bearer plugin), a 400 returns an OAuth error code: authorization_pending,
 *     slow_down, access_denied, expired_token, ...
 *
 * Everything is Result-typed (the skill's rule: failure is a value, not a throw)
 * and the IO (`fetch`, `sleep`, `now`) is injectable so the whole flow is unit-
 * testable without a network.
 *
 * @module lib/auth
 */

/** The grant_type literal RFC 8628 / better-auth requires on the token call. */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

/** Response of `POST /device/code`. */
export interface DeviceCodeResponse {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete?: string
  /** Seconds until the device_code expires. */
  readonly expires_in: number
  /** Minimum seconds between token polls. */
  readonly interval: number
}

/** The bearer token + who it belongs to, distilled from a successful token exchange. */
export interface DeviceToken {
  /** The bearer token to send as `Authorization: Bearer <token>`. */
  readonly accessToken: string
  /** Best-effort user id, when the backend returned one. */
  readonly userId?: string
  /** Unix ms the token was obtained (for staleness/refresh later). */
  readonly obtainedAt: number
}

/** Injected IO so the flow is testable without a real network/clock. */
export interface AuthIo {
  fetch: typeof fetch
  /** Resolve after `ms` (injected so tests don't actually wait). */
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/** Default IO: real fetch + a real timer. */
export function defaultAuthIo(): AuthIo {
  return {
    fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}

/** A Result: ok value or a typed error reason. The skill's Result pattern. */
export type AuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/** Options for {@link requestDeviceCode}. */
export interface DeviceCodeOptions {
  /** Auth base URL, e.g. `http://localhost:4000/api/auth`. */
  readonly baseUrl: string
  /** OAuth client id the CLI identifies as. */
  readonly clientId: string
  /** Requested scope(s). Space-delimited per OAuth. Optional. */
  readonly scope?: string
}

/** Normalize a base url (strip a trailing slash) so path joins are clean. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, "")
}

/** Step 1 — request a device + user code. */
export async function requestDeviceCode(
  io: AuthIo,
  opts: DeviceCodeOptions,
): Promise<AuthResult<DeviceCodeResponse>> {
  const url = `${trimBase(opts.baseUrl)}/device/code`
  let res: Response
  try {
    res = await io.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        ...(opts.scope ? { scope: opts.scope } : {}),
      }),
    })
  } catch (e) {
    return { ok: false, reason: `device/code request failed: ${errText(e)}` }
  }
  if (!res.ok) {
    return { ok: false, reason: `device/code returned ${res.status}: ${await safeBody(res)}` }
  }
  let body: Partial<DeviceCodeResponse>
  try {
    body = (await res.json()) as Partial<DeviceCodeResponse>
  } catch (e) {
    return { ok: false, reason: `device/code bad JSON: ${errText(e)}` }
  }
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    return { ok: false, reason: "device/code response missing required fields" }
  }
  return {
    ok: true,
    value: {
      device_code: body.device_code,
      user_code: body.user_code,
      verification_uri: body.verification_uri,
      ...(body.verification_uri_complete
        ? { verification_uri_complete: body.verification_uri_complete }
        : {}),
      expires_in: typeof body.expires_in === "number" ? body.expires_in : 900,
      interval: typeof body.interval === "number" ? body.interval : 5,
    },
  }
}

/** Options for {@link pollForToken}. */
export interface PollOptions extends DeviceCodeOptions {
  readonly deviceCode: string
  /** Seconds between polls (server-provided). Bumped on `slow_down`. */
  readonly interval: number
  /** Seconds until the device_code expires (overall deadline). */
  readonly expiresIn: number
}

/**
 * Step 2 — poll `/device/token` until the user approves, denies, or it expires.
 *
 * Handles the RFC 8628 polling states: `authorization_pending` (keep waiting),
 * `slow_down` (increase interval by 5s, per spec), `access_denied` /
 * `expired_token` (terminal failures). On success extracts the bearer token from
 * the `set-auth-token` response header (the bearer() plugin) with a `session.token`
 * body fallback.
 */
export async function pollForToken(
  io: AuthIo,
  opts: PollOptions,
): Promise<AuthResult<DeviceToken>> {
  const url = `${trimBase(opts.baseUrl)}/device/token`
  const deadline = io.now() + opts.expiresIn * 1000
  let intervalMs = Math.max(1, opts.interval) * 1000

  while (io.now() < deadline) {
    await io.sleep(intervalMs)
    let res: Response
    try {
      res = await io.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: opts.deviceCode,
          client_id: opts.clientId,
        }),
      })
    } catch {
      // Transient network error: keep polling until the deadline.
      continue
    }

    if (res.ok) {
      const token = await extractToken(io, res)
      if (token) return { ok: true, value: token }
      return { ok: false, reason: "token exchange succeeded but no bearer token was returned" }
    }

    // 400 with an OAuth error code drives the polling state machine.
    const err = await readError(res)
    if (err === "authorization_pending") continue
    if (err === "slow_down") {
      intervalMs += 5000 // RFC 8628 §3.5
      continue
    }
    if (err === "access_denied") return { ok: false, reason: "access denied by the user" }
    if (err === "expired_token")
      return { ok: false, reason: "the device code expired before approval" }
    return { ok: false, reason: `token exchange failed: ${err ?? res.status}` }
  }
  return { ok: false, reason: "timed out waiting for device approval" }
}

/** Pull the bearer token from the `set-auth-token` header, or the session body. */
async function extractToken(io: AuthIo, res: Response): Promise<DeviceToken | null> {
  const header = res.headers.get("set-auth-token") ?? res.headers.get("Set-Auth-Token")
  let userId: string | undefined
  let bodyToken: string | undefined
  try {
    const body = (await res.clone().json()) as {
      session?: { token?: string; userId?: string }
      user?: { id?: string }
    }
    bodyToken = body.session?.token
    userId = body.user?.id ?? body.session?.userId
  } catch {
    // body may be empty/non-JSON; the header path still works
  }
  const accessToken = (header && header.length > 0 ? header : bodyToken) ?? ""
  if (!accessToken) return null
  return { accessToken, ...(userId ? { userId } : {}), obtainedAt: io.now() }
}

/** Read the OAuth `error` code from a 400 body, tolerating non-JSON. */
async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: string }
    return typeof body.error === "string" ? body.error : null
  } catch {
    return null
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return "<unreadable>"
  }
}
