/**
 * Credential shapes of the Antigravity provider.
 *
 * Two sources feed one shape:
 *
 * 1. A fresh loopback login (`oauth-login.ts`), which stores an OAuth token in
 *    the host credential store.
 * 2. An import of the token file that the `agy` CLI already wrote, which lets
 *    a user start with no new consent screen.
 *
 * The bag is plain and JSON-safe, so it survives a round trip through
 * `~/.minimal-agent/auth.jsonc`. No field here is a secret in the UI sense,
 * but `accessToken` and `refreshToken` stay out of every log.
 *
 * @module llm/providers/antigravity/auth
 */

import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { AuthSecretBag, AuthSecretValue } from "./lib/provider-plugin.ts"
import { AGY_TOKEN_FILE_NAME } from "./wire-constants.ts"

/**
 * Stored credential bag of this provider.
 *
 * `expiresAt` is epoch milliseconds. The `agy` file keeps an RFC3339 string
 * instead, so {@link readAgyTokenFile} converts it once at import time and the
 * rest of the plugin never parses a date string.
 */
export interface AntigravitySecrets {
  tokenType: "oauth"
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  idToken?: string
  email?: string
  /** `"consumer"` for a Google AI plan account. */
  authMethod?: string
  /** Project id from `loadCodeAssist`, cached at login. */
  project?: string
  /** Space-separated scopes as the token endpoint echoed them. */
  scope?: string
  /** Absolute path when the credential came from the `agy` token file. */
  importedFrom?: string
}

/** Access tokens live one hour. Refresh early so no request wastes a round trip. */
export const REFRESH_SKEW_MS = 60_000

/** Google access-token lifetime when the response omits `expires_in`. */
const DEFAULT_LIFETIME_S = 3_599

/**
 * Convert the typed shape into the host's opaque bag.
 *
 * Undefined fields are dropped rather than written as `undefined`, because the
 * store serializes to JSON and a `null` would read back as a missing field
 * anyway.
 */
export function antigravitySecretsToBag(secrets: AntigravitySecrets): AuthSecretBag {
  const bag: AuthSecretBag = {
    tokenType: secrets.tokenType,
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
    expiresAt: secrets.expiresAt,
  }
  const optional: ReadonlyArray<[string, string | undefined]> = [
    ["idToken", secrets.idToken],
    ["email", secrets.email],
    ["authMethod", secrets.authMethod],
    ["project", secrets.project],
    ["scope", secrets.scope],
    ["importedFrom", secrets.importedFrom],
  ]
  for (const [key, value] of optional) {
    if (value !== undefined) bag[key] = value
  }
  return bag
}

function text(value: AuthSecretValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Read the bag back. Returns `null` when the required fields are absent, so a
 * corrupt or foreign entry is skipped instead of throwing inside the agent
 * loop.
 */
export function readAntigravitySecrets(secrets: AuthSecretBag): AntigravitySecrets | null {
  const accessToken = text(secrets.accessToken)
  const refreshToken = text(secrets.refreshToken)
  if (!accessToken || !refreshToken) return null
  const expiresAt = typeof secrets.expiresAt === "number" ? secrets.expiresAt : 0
  return {
    tokenType: "oauth",
    accessToken,
    refreshToken,
    expiresAt,
    idToken: text(secrets.idToken),
    email: text(secrets.email),
    authMethod: text(secrets.authMethod),
    project: text(secrets.project),
    scope: text(secrets.scope),
    importedFrom: text(secrets.importedFrom),
  }
}

/**
 * Absolute expiry in milliseconds from any of the three shapes a token source
 * can give us:
 *
 * 1. a Google token response with `expires_in` in seconds,
 * 2. the `agy` file with `expiry` as an RFC3339 string,
 * 3. a value already in epoch milliseconds (`expiresAt`).
 *
 * A missing or unparseable value yields `now + 1h`, which is the Google
 * default and keeps the refresh check conservative.
 */
export function antigravityExpiresAt(
  raw: Record<string, unknown>,
  nowMs: number = Date.now(),
): number {
  const direct = raw.expiresAt
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct

  const expiresIn = raw.expires_in
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return nowMs + expiresIn * 1_000
  }
  if (typeof expiresIn === "string") {
    const parsed = Number(expiresIn)
    if (Number.isFinite(parsed) && parsed > 0) return nowMs + parsed * 1_000
  }

  const expiry = raw.expiry ?? raw.expiryTime
  if (typeof expiry === "string" && expiry.length > 0) {
    const ms = Date.parse(expiry)
    if (Number.isFinite(ms)) return ms
  }

  return nowMs + DEFAULT_LIFETIME_S * 1_000
}

/** True when the token is expired or inside the refresh window. */
export function isExpired(
  secrets: AntigravitySecrets,
  nowMs: number = Date.now(),
  skewMs: number = REFRESH_SKEW_MS,
): boolean {
  if (!Number.isFinite(secrets.expiresAt) || secrets.expiresAt <= 0) return true
  return secrets.expiresAt - skewMs <= nowMs
}

/** Cap of the token expiry record. One entry for each access token the host read. */
const TOKEN_EXPIRY_MAX = 64

/**
 * Expiry of each access token that `readAuth` returned, keyed by the token.
 *
 * `ProviderAuth` has no expiry field, so the adapter cannot see when a token
 * expires. `readAuth` records it here, and the adapter reads it before a turn
 * to refresh a token that is inside the refresh window.
 */
const tokenExpiry = new Map<string, number>()

/** Record the expiry of one access token. */
export function rememberTokenExpiry(accessToken: string, expiresAt: number): void {
  if (!accessToken) return
  tokenExpiry.delete(accessToken)
  if (tokenExpiry.size >= TOKEN_EXPIRY_MAX) {
    const oldest = tokenExpiry.keys().next()
    if (!oldest.done) tokenExpiry.delete(oldest.value)
  }
  tokenExpiry.set(accessToken, expiresAt)
}

/**
 * True when the recorded expiry of `accessToken` is inside the refresh window.
 * An unknown token gives `false`: the host 401 path still recovers it.
 */
export function tokenNeedsRefresh(
  accessToken: string,
  nowMs: number = Date.now(),
  skewMs: number = REFRESH_SKEW_MS,
): boolean {
  const expiresAt = tokenExpiry.get(accessToken)
  if (expiresAt === undefined) return false
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true
  return expiresAt - skewMs <= nowMs
}

/** Drop the token expiry record. Tests call this between cases. */
export function clearTokenExpiry(): void {
  tokenExpiry.clear()
}

/**
 * Candidate paths of the `agy` token file, most specific first.
 *
 * The CLI keeps its token under the `antigravity-cli` directory. The older
 * standalone path is still written by some builds, so an import tries both.
 */
export function agyTokenFilePaths(home: string = homedir()): string[] {
  return [
    join(home, ".gemini", "antigravity-cli", AGY_TOKEN_FILE_NAME),
    join(home, ".gemini", `jetski-standalone-oauth-token`),
  ]
}

/**
 * Read a file that only the owner can read.
 *
 * `readFileSync` throws `EACCES` on a `0600` file owned by another user, and
 * the caller must treat that as "no token" rather than as a crash. The file is
 * also opened read-only: this plugin never writes the `agy` store, because the
 * CLI rewrites the whole file on its own schedule and a second writer would
 * corrupt it.
 */
function readPrivateFile(path: string): string | null {
  try {
    const fd = openSync(path, "r")
    try {
      const buf = Buffer.allocUnsafe(8_192)
      const read = readSync(fd, buf, 0, buf.length, 0)
      return buf.subarray(0, read).toString("utf8")
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

interface AgyTokenFile {
  token?: {
    access_token?: string
    token_type?: string
    refresh_token?: string
    expiry?: string
  }
  auth_method?: string
  id_token?: string
}

/**
 * Import the token file that the `agy` CLI wrote.
 *
 * The file shape, verified on a live install, is:
 *
 * ```json
 * {
 *   "token": {
 *     "access_token": "...",
 *     "token_type": "Bearer",
 *     "refresh_token": "...",
 *     "expiry": "2026-11-20T07:08:19.300175-05:00"
 *   },
 *   "auth_method": "consumer",
 *   "id_token": "..."
 * }
 * ```
 *
 * Returns `null` on a missing, unreadable, or incomplete file. The caller
 * decides whether that is an error, because "not logged in yet" is a normal
 * state.
 */
export function readAgyTokenFile(path?: string): AntigravitySecrets | null {
  const candidates = path ? [path] : agyTokenFilePaths()
  for (const candidate of candidates) {
    const raw = readPrivateFile(candidate)
    if (!raw) continue
    let parsed: AgyTokenFile
    try {
      parsed = JSON.parse(raw) as AgyTokenFile
    } catch {
      continue
    }
    const token = parsed.token
    const accessToken = token?.access_token
    const refreshToken = token?.refresh_token
    if (!accessToken || !refreshToken) continue
    return {
      tokenType: "oauth",
      accessToken,
      refreshToken,
      expiresAt: antigravityExpiresAt({ expiry: token?.expiry }),
      idToken: parsed.id_token,
      authMethod: parsed.auth_method,
      importedFrom: candidate,
    }
  }
  return null
}

/** Re-export for tests that build a fixture from a string. */
export const __test = { readPrivateFile, DEFAULT_LIFETIME_S, readFileSync }
