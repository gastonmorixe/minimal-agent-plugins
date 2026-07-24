/**
 * Cursor Connect request headers.
 *
 * Auth: Bearer token must already be resolved from MA ProviderAuth
 * (oauth access token or api-key exchange result). Never reads env secrets
 * or keychain.
 *
 * @module llm/providers/cursor/headers
 */

import { buildCursorChecksum } from "./checksum.ts"
import type { ClientIds } from "./ids.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION_DEFAULT,
  CURSOR_CONNECT_PROTOCOL_VERSION,
  CURSOR_GHOST_MODE_DEFAULT,
  CURSOR_STREAM_CONTENT_TYPE,
  CURSOR_UNARY_CONTENT_TYPE,
  CURSOR_USER_AGENT,
} from "./wire-constants.ts"

/**
 * Extract a bearer string from MA {@link ProviderAuth} only.
 * - oauth → stored access token (device login / exchange, core-managed)
 * - api-key → null (caller must exchange via auth.exchangeCursorApiKey)
 * - custom → optional Authorization header from host-built auth
 *
 * Never reads process.env or keychain.
 */
export function bearerToken(auth: ProviderAuth): string | null {
  if (auth.kind === "oauth") return auth.token || null
  if (auth.kind === "api-key") return null
  const authorization = auth.headers.authorization ?? auth.headers.Authorization
  return authorization?.replace(/^Bearer\s+/i, "") || null
}

/** Compatibility alias for {@link bearerToken} (scaffold / index re-exports). */
export const resolveCursorBearer = bearerToken

export interface CursorHeaderOptions {
  token: string
  ids: ClientIds
  streaming?: boolean
  clientType?: string
  clientLayout?: string
  ghostMode?: boolean
  requestId?: string
  nowMs?: number
  extra?: Readonly<Record<string, string>>
}

/** Build Cursor fingerprint + auth headers shared by unary and stream calls. */
export function buildCursorHeaders(options: CursorHeaderOptions): Record<string, string> {
  const requestId = options.requestId ?? crypto.randomUUID()
  const headers: Record<string, string> = {
    accept: options.streaming ? CURSOR_STREAM_CONTENT_TYPE : CURSOR_UNARY_CONTENT_TYPE,
    authorization: `Bearer ${options.token}`,
    "connect-protocol-version": CURSOR_CONNECT_PROTOCOL_VERSION,
    "content-type": options.streaming ? CURSOR_STREAM_CONTENT_TYPE : CURSOR_UNARY_CONTENT_TYPE,
    "user-agent": CURSOR_USER_AGENT,
    "x-amzn-trace-id": `Root=${requestId}`,
    "x-client-key": options.ids.clientKey,
    "x-cursor-checksum": buildCursorChecksum(
      options.ids.machineId,
      options.ids.macMachineId,
      options.nowMs,
    ),
    "x-cursor-client-arch": process.arch === "arm64" ? "arm64" : "x64",
    "x-cursor-client-device-type": "desktop",
    "x-cursor-client-os": process.platform === "darwin" ? "darwin" : process.platform,
    "x-cursor-client-type": options.clientType ?? CURSOR_CLIENT_TYPE,
    // Spike-proven client version (not package 0.1.0). Override via MA_CURSOR_CLIENT_VERSION.
    "x-cursor-client-version":
      process.env.MA_CURSOR_CLIENT_VERSION ?? CURSOR_CLIENT_VERSION_DEFAULT,
    "x-cursor-streaming": options.streaming === false ? "false" : "true",
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "x-ghost-mode": String(options.ghostMode ?? CURSOR_GHOST_MODE_DEFAULT),
    "x-request-id": requestId,
    "x-session-id": options.ids.sessionId,
  }
  // Match spike probe-run headers for AgentService/Run (harmless on unary).
  if (options.streaming !== false) {
    headers["connect-accept-encoding"] = "gzip"
  }
  if (options.clientLayout) headers["x-cursor-client-layout"] = options.clientLayout
  if (options.ids.configVersion) {
    headers["x-cursor-config-version"] = options.ids.configVersion
  }
  if (options.extra) Object.assign(headers, options.extra)
  return headers
}
