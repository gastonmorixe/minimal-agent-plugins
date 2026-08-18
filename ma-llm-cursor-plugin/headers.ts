/**
 * Cursor Connect request headers.
 *
 * Default fingerprint is **CLI** (Cursor Agent CLI AgentService interceptor):
 * auth, ghost-mode, client-type/version, request-id. Do **not** add IDE
 * checksum / client-key / session-id on this path — that is Connect
 * `resource_exhausted` “Too many computers” while `cursor-agent` still works.
 * Full incident: `docs/agent-run-too-many-computers-postmortem.md`.
 *
 * Auth: Bearer token must already be resolved from MA ProviderAuth
 * (oauth access token or api-key exchange result). Never reads env secrets
 * or keychain.
 *
 * @module llm/providers/cursor/headers
 */

import { buildCursorChecksum } from "./checksum.ts"
import { resolveCursorClientVersion } from "./client-version.ts"
import type { ClientIds } from "./ids.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import {
  CURSOR_CLIENT_TYPE,
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
  /**
   * `cli` (default) matches Cursor Agent CLI AgentService interceptors:
   * auth + ghost + client-type/version + request-id. No IDE checksum.
   * `ide` restores the workbench fingerprint headers (checksum / client-key).
   */
  fingerprint?: "cli" | "ide"
}

/** Build Cursor auth headers shared by unary and stream calls. */
export function buildCursorHeaders(options: CursorHeaderOptions): Record<string, string> {
  const requestId = options.requestId ?? crypto.randomUUID()
  const fingerprint = options.fingerprint ?? "cli"
  const headers: Record<string, string> = {
    accept: options.streaming ? CURSOR_STREAM_CONTENT_TYPE : CURSOR_UNARY_CONTENT_TYPE,
    authorization: `Bearer ${options.token}`,
    "connect-protocol-version": CURSOR_CONNECT_PROTOCOL_VERSION,
    "content-type": options.streaming ? CURSOR_STREAM_CONTENT_TYPE : CURSOR_UNARY_CONTENT_TYPE,
    "user-agent": CURSOR_USER_AGENT,
    "x-cursor-client-type": options.clientType ?? CURSOR_CLIENT_TYPE,
    "x-cursor-client-version": resolveCursorClientVersion(),
    "x-ghost-mode": String(options.ghostMode ?? CURSOR_GHOST_MODE_DEFAULT),
    "x-request-id": requestId,
  }
  // Match Cursor Agent CLI stream interceptor (gzip); not an IDE-only header.
  if (options.streaming !== false) {
    headers["connect-accept-encoding"] = "gzip"
  }
  if (fingerprint === "ide") {
    headers["x-amzn-trace-id"] = `Root=${requestId}`
    headers["x-client-key"] = options.ids.clientKey
    headers["x-cursor-checksum"] = buildCursorChecksum(
      options.ids.machineId,
      options.ids.macMachineId,
      options.nowMs,
    )
    headers["x-cursor-client-arch"] = process.arch === "arm64" ? "arm64" : "x64"
    headers["x-cursor-client-device-type"] = "desktop"
    headers["x-cursor-client-os"] = process.platform === "darwin" ? "darwin" : process.platform
    headers["x-cursor-streaming"] = options.streaming === false ? "false" : "true"
    headers["x-cursor-timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone
    headers["x-session-id"] = options.ids.sessionId
  }
  if (options.clientLayout) headers["x-cursor-client-layout"] = options.clientLayout
  if (options.ids.configVersion) {
    headers["x-cursor-config-version"] = options.ids.configVersion
  }
  if (options.extra) Object.assign(headers, options.extra)
  return headers
}
