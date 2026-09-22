/**
 * Wire constants for the Anthropic Messages API.
 *
 * This module is the single source of truth for the Anthropic/claude-code
 * wire identity the adapter sends: protocol version, User-Agent strings,
 * Stainless SDK version, and the build-info tuple the billing header carries.
 * These are claude-code mimicry values (the server sees them), so they live
 * in the provider plugin, never in core.
 *
 * Source of truth for VERSION / Stainless / billing-header format: the
 * claude-code 2.1.280 bundle. Since 2.1.2xx the npm root package is a thin
 * installer; the real code ships as a Bun single-file executable in the
 * platform package (`@anthropic-ai/claude-code-darwin-arm64`), so the
 * evidence below comes from strings extracted out of that binary.
 *
 * @module llm/providers/anthropic/wire-constants
 */

import { createHash } from "node:crypto"

/**
 * claude-code CLI version string. Sent in the User-Agent and the billing
 * header; the server validates it. Models gate on a minimum CLI version, so
 * a stale value here makes the API reject new models with HTTP 400
 * `claude_code_version_too_old` ("version 2.1.280 or newer is required").
 * This is the upstream CLI's version we mimic, NOT minimal-agent's own
 * version (that's `AGENT_VERSION` in `src/build-info.ts`).
 *
 * Source: the inlined build-info literal in the 2.1.280 binary,
 * `{…,VERSION:"2.1.280",BUILD_TIME:"2026-09-21T20:40:17Z",GIT_SHA:"80abbfe7…"}`.
 */
export const VERSION = "2.1.280"

/**
 * Salt the CLI mixes into the billing-header hash suffix.
 * Source: `var sOn="59cf53e54c78"` in the 2.1.280 binary.
 */
const BUILD_HASH_SALT = "59cf53e54c78"

/**
 * Compute the billing-header hash suffix the way claude-code 2.1.280 does.
 *
 * The suffix is NOT a per-build constant (it was through 2.1.154). The CLI
 * derives it per conversation from the FIRST user message text:
 *
 * ```js
 * let s = [4,7,20].map(i => text[i] || "0").join("")
 * sha256(`${salt}${s}${version}`).slice(0, 3)
 * ```
 *
 * The server logs the suffix for attribution but does not validate it, so a
 * caller with no first-message text in hand can use {@link BUILD_HASH}.
 *
 * @param firstUserText - Text of the first user message ("" when unknown).
 * @param version - CLI version string mixed into the digest.
 * @returns The 3-character lowercase hex suffix.
 */
export function buildHashFor(firstUserText: string, version: string = VERSION): string {
  const picked = [4, 7, 20].map((i) => firstUserText[i] || "0").join("")
  return createHash("sha256")
    .update(`${BUILD_HASH_SALT}${picked}${version}`)
    .digest("hex")
    .slice(0, 3)
}

/**
 * Default hash suffix for `cc_version=${VERSION}.${BUILD_HASH}`: the value
 * {@link buildHashFor} yields for an empty first message. The system-prompt
 * seam has no access to the message array, so this is what actually goes on
 * the wire. Kept derived (not a magic literal) so a VERSION bump stays
 * self-consistent.
 */
export const BUILD_HASH: string = buildHashFor("")

/**
 * Build timestamp + git sha. Not sent in requests, informational only.
 * Source: the build-info literal in the 2.1.280 binary.
 */
export const BUILD_TIME = "2026-09-21T20:40:17Z"
export const GIT_SHA = "80abbfe7d7232280011ff01a21ae3338f4c6e372"

/**
 * Anthropic API version header value. Constant "2023-06-01" across every
 * version tracked (2.1.12 through 2.1.280).
 */
export const ANTHROPIC_VERSION = "2023-06-01"

/**
 * Messages API URL with the `?beta=true` query parameter. All real CLI
 * requests include it (set by the Stainless SDK's beta handling).
 */
export const API_URL = "https://api.anthropic.com/v1/messages?beta=true"

/**
 * User-Agent string for the Stainless SDK path that hits /v1/messages.
 * `claude-cli/${VERSION} (external, cli)` for the standard CLI entrypoint.
 */
export const USER_AGENT = `claude-cli/${VERSION} (external, cli)`

/**
 * User-Agent variants for non-Stainless endpoints:
 *   - `claude-code/${VERSION}`       → /api/oauth/account/settings
 *   - `claude-code/${VERSION} (cli)` → mcp-proxy.anthropic.com/v1/mcp/...
 */
export const USER_AGENT_OAUTH = `claude-code/${VERSION}`
export const USER_AGENT_MCP = `claude-code/${VERSION} (cli)`

/**
 * Stainless `@anthropic-ai/sdk` package version bundled into the CLI, sent as
 * `x-stainless-package-version`. 0.112.1 in v2.1.280 (was 0.94.0 in 2.1.154).
 */
export const STAINLESS_SDK_VERSION = "0.112.1"

/** Bootstrap endpoint introduced in v2.1.154. */
export const BOOTSTRAP_URL_BASE = "https://api.anthropic.com/api/claude_cli/bootstrap"

/** Models endpoint (`GET /v1/models?beta=true`). */
export const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"
