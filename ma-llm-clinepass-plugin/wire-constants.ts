/**
 * Wire constants for the ClinePass / Cline API gateway.
 *
 * ClinePass rides the same OpenAI-compatible surface as Cline usage-billing:
 * `https://api.cline.bot/api/v1/chat/completions` with model IDs under the
 * `cline-pass/` prefix. Auth is either a dashboard API key or a WorkOS
 * device-code OAuth session registered with Cline.
 *
 * @module llm/providers/clinepass/wire-constants
 */

/** Production Cline API host. */
export const CLINE_API_BASE_URL = "https://api.cline.bot"

/** Production Cline app / dashboard host. */
export const CLINE_APP_BASE_URL = "https://app.cline.bot"

/** OpenAI-compatible base path used by OpenAI clients (`base_url`). */
export const CLINE_OPENAI_BASE = `${CLINE_API_BASE_URL}/api/v1`

/** Chat Completions endpoint. */
export const CHAT_COMPLETIONS_URL = `${CLINE_OPENAI_BASE}/chat/completions`

/** Model-list endpoint (often incomplete for Pass-only; catalog is static). */
export const MODELS_URL = `${CLINE_OPENAI_BASE}/models`

/** Cline auth endpoints (account tokens, not API keys). */
export const CLINE_AUTH = {
  authorize: `${CLINE_API_BASE_URL}/api/v1/auth/authorize`,
  token: `${CLINE_API_BASE_URL}/api/v1/auth/token`,
  register: `${CLINE_API_BASE_URL}/api/v1/auth/register`,
  refresh: `${CLINE_API_BASE_URL}/api/v1/auth/refresh`,
} as const

/** WorkOS User Management (device authorization for Cline login). */
export const WORKOS_API_BASE_URL = "https://api.workos.com"
export const WORKOS_DEVICE_AUTHORIZATION_URL = `${WORKOS_API_BASE_URL}/user_management/authorize/device`
export const WORKOS_AUTHENTICATE_URL = `${WORKOS_API_BASE_URL}/user_management/authenticate`

/**
 * Production WorkOS client id from Cline's environment config
 * (`sdk/packages/shared/src/runtime/cline-environment.ts`).
 */
export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"

/** Account / quota endpoints. */
export const CLINE_ACCOUNT = {
  me: `${CLINE_API_BASE_URL}/api/v1/users/me`,
  plan: `${CLINE_API_BASE_URL}/api/v1/users/me/plan`,
  balance: (userId: string) =>
    `${CLINE_API_BASE_URL}/api/v1/users/${encodeURIComponent(userId)}/balance`,
  usages: (userId: string) =>
    `${CLINE_API_BASE_URL}/api/v1/users/${encodeURIComponent(userId)}/usages`,
  plans: `${CLINE_API_BASE_URL}/api/v1/plans`,
} as const

/** User-Agent the adapter advertises. */
export const CLINEPASS_USER_AGENT = "minimal-agent-clinepass/0.1"

/** Default attribution headers (Cline gateway accepts these for usage tracking). */
export const CLINEPASS_DEFAULT_HEADERS = {
  "HTTP-Referer": "https://github.com/gastonmorixe/minimal-agent",
  "X-Title": "minimal-agent",
  "X-CLIENT-TYPE": "minimal-agent",
  "X-CLIENT-VERSION": "0.1",
  "User-Agent": CLINEPASS_USER_AGENT,
} as const

/** Dashboard URL for ClinePass subscription. */
export const CLINEPASS_SUBSCRIBE_URL = `${CLINE_APP_BASE_URL}/dashboard/subscription?personal=true`
