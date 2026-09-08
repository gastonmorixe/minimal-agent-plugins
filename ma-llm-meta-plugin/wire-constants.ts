/**
 * Wire constants for Meta Model API (Muse Spark).
 *
 * Product: Meta Model API at `https://api.meta.ai/v1` (alias `api.ai.meta.com`).
 * Auth: `Authorization: Bearer <MODEL_API_KEY>` (keys look like `LLM_…`).
 * Do not target the retired Llama API (`api.llama.com` / `LLAMA_API_KEY`).
 *
 * @module llm/providers/meta/wire-constants
 */

/** Production Meta Model API host. */
export const META_API_BASE_URL = "https://api.meta.ai"

/** OpenAI-compatible base path (`base_url` for SDKs). */
export const META_OPENAI_BASE = `${META_API_BASE_URL}/v1`

/** Chat Completions endpoint. */
export const CHAT_COMPLETIONS_URL = `${META_OPENAI_BASE}/chat/completions`

/** Responses API endpoint (OpenAI Responses shape; phase-2 adapter optional). */
export const RESPONSES_URL = `${META_OPENAI_BASE}/responses`

/** Anthropic Messages compatibility endpoint (phase-2). */
export const MESSAGES_URL = `${META_OPENAI_BASE}/messages`

/** Live model list. */
export const MODELS_URL = `${META_OPENAI_BASE}/models`

/** Developer console / API key minting. */
export const META_DEV_CONSOLE_URL = "https://dev.meta.ai/"

/** Product / docs entry (often bot-walled to bare curl). */
export const META_DOCS_URL = "https://ai.developer.meta.com/"

/** User-Agent the adapter advertises. */
export const META_USER_AGENT = "minimal-agent-meta/0.1"

/** Default attribution headers. */
export const META_DEFAULT_HEADERS = {
  "HTTP-Referer": "https://github.com/gastonmorixe/minimal-agent",
  "X-Title": "minimal-agent",
  "User-Agent": META_USER_AGENT,
} as const

// ---------------------------------------------------------------------------
// Muse Code OAuth (device code) — Observed from muse-launcher.sh
// ---------------------------------------------------------------------------

/** Meta OIDC host used by Muse CLI device login. */
export const MUSE_AUTH_BASE_URL = "https://auth.meta.com"

/** Public Muse CLI OAuth client id. */
export const MUSE_CLIENT_ID = "1031625952748946"

/** RFC 8628 device authorization endpoint. */
export const MUSE_DEVICE_AUTHORIZATION_URL = `${MUSE_AUTH_BASE_URL}/oidc/device/authorization/`

/** RFC 8628 device token endpoint. */
export const MUSE_DEVICE_TOKEN_URL = `${MUSE_AUTH_BASE_URL}/oidc/device/token/`

/** Device-code grant type. */
export const MUSE_DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/**
 * User-Agent Muse launcher sends on auth POSTs (`muse-code/launcher-2`).
 * Keep aligned so Meta does not treat us as a foreign client.
 */
export const MUSE_OAUTH_USER_AGENT = "muse-code/launcher-2"

/**
 * Muse Code key-mint path (**Inferred** from binary: `https://api.meta.ai` +
 * `muse-code/key`). Override with `TBH_MINT_BASE_URL` + path if Meta changes it.
 */
export const MUSE_KEY_MINT_URL = `${META_API_BASE_URL}/muse-code/key`

/** API version header Muse CLI sends on Meta front-door calls. */
export const MUSE_API_VERSION = "1.0.0"

/** Client surface id Muse CLI sends (`tbh:tui` | `tbh:exec` | `tbh:desktop`). */
export const MUSE_CLIENT_ID_HEADER = "tbh:exec"
