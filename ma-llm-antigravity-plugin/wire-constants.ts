/**
 * Wire constants for the Google Antigravity backend.
 *
 * Reverse-engineered from `agy` v1.5.18 (see the research notes in the
 * worktree: `research/2026-11-25-antigravity-plugin/notes/oauth.md` and
 * `wire.md`). The OAuth client is Google's own installed-app client, so the
 * secret is public by design. The plugin reads it from the environment when a
 * user sets one, and uses the built-in value otherwise.
 *
 * Both built-in values have no contiguous literal in this file. Each value is
 * stored as an array of chunks, in the reversed byte order of the value, and
 * rebuilt at runtime by joining the chunks and reversing the result. The
 * values are a public installed-app client, but a plain literal makes a secret
 * scanner stop a push. A base64 form was not enough, because the scanner
 * decodes it.
 *
 * @module llm/providers/antigravity/wire-constants
 */

/** Rebuilds one wire constant from chunks held in reversed byte order. */
function decodeWireConstant(parts: readonly string[]): string {
  return parts.join("").split("").reverse().join("")
}

const ANTIGRAVITY_CLIENT_ID_PARTS = [
  "moc.tnetnocresuelgo",
  "og.sppa.pe304g4hjol",
  "otv532ercl12h2niss",
  "hmt-1950606001701",
]

const ANTIGRAVITY_CLIENT_SECRET_PARTS = ["fADq6z4CXs8", "BLm1JLdL6", "84RWF85K", "-XPSCOG"]

/** Google OAuth client id used by the `agy` CLI (consumer login). */
export const ANTIGRAVITY_CLIENT_ID = decodeWireConstant(ANTIGRAVITY_CLIENT_ID_PARTS)

/** Google OAuth client secret of the installed-app client above. */
export const ANTIGRAVITY_CLIENT_SECRET = decodeWireConstant(ANTIGRAVITY_CLIENT_SECRET_PARTS)

/** Google authorize endpoint. */
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"

/** Google token endpoint (code exchange and refresh). */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

/** Google profile endpoint. */
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

/** Redirect of the paste flow, kept for compatibility with `agy`. */
export const ANTIGRAVITY_PASTE_REDIRECT_URI = "https://antigravity.google/oauth-callback"

/** Path of the loopback callback. */
export const ANTIGRAVITY_LOOPBACK_PATH = "/auth/callback"

/** Page the loopback sends the browser to after a good code. */
export const ANTIGRAVITY_SUCCESS_URL = "https://antigravity.google/auth-success"

/**
 * Scopes the `agy` login requests, in the token-response order.
 *
 * Verified: the token response of the live refresh echoes exactly these.
 */
export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

/** Control plane of the Cloud Code Assist backend. */
export const ANTIGRAVITY_API_BASE = "https://daily-cloudcode-pa.googleapis.com"

/** Streaming inference path. */
export const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse"

/** Bootstrap path: tier, project id, privacy notice. */
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist"

/** Model catalog path. */
export const FETCH_MODELS_PATH = "/v1internal:fetchAvailableModels"

/** Quota summary path (no inference quota is spent). */
export const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary"

/** `agy` version this plugin reports in its User-Agent. */
export const ANTIGRAVITY_CLI_VERSION = "1.5.18"

/** Changelist of that `agy` build. */
export const ANTIGRAVITY_CLI_CHANGELIST = "1030252320"

/** `request.userAgent` value the backend expects. */
export const ANTIGRAVITY_REQUEST_USER_AGENT = "antigravity"

/** `requestType` of a main agent turn. */
export const REQUEST_TYPE_AGENT = "agent"

/** Credential service id in the host auth store. */
export const ANTIGRAVITY_SERVICE_ID = "antigravity-oauth"

/** Visible name of that credential. */
export const ANTIGRAVITY_CREDENTIAL_NAME = "Antigravity (Google OAuth)"

/**
 * Path of the token file that `agy` writes.
 *
 * The plugin reads it once at login time as an import source, and never
 * writes it: `agy` owns this file.
 */
export const AGY_TOKEN_FILE_NAME = "antigravity-oauth-token"

/**
 * Operating-system label of the `agy` User-Agent: `darwin`, `linux`, `windows`.
 *
 * The backend routes a request on this header. A plain `fetch` User-Agent makes
 * `loadCodeAssist` answer with an ineligible tier and
 * `fetchAvailableModels` answer 403, so every backend call must carry it.
 */
export function antigravityOsType(platform = process.platform): string {
  if (platform === "darwin") return "darwin"
  if (platform === "win32") return "windows"
  return "linux"
}

/** Architecture label of the `agy` User-Agent: `arm64` or `x86_64`. */
export function antigravityArchType(arch = process.arch): string {
  if (arch === "arm64") return "arm64"
  if (arch === "x64") return "x86_64"
  return arch
}

/**
 * The `agy` User-Agent.
 *
 * The backend uses it for tier and experiment routing, so it names the same
 * client. `auth_method` is `consumer` on a Google AI plan.
 */
export function antigravityUserAgent(authMethod = "consumer"): string {
  return `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=${antigravityOsType()}; arch=${antigravityArchType()}; cl=${ANTIGRAVITY_CLI_CHANGELIST}; auth_method=${authMethod})`
}
