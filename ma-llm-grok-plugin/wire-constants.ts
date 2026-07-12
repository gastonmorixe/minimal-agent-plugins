/**
 * Wire constants for the xAI Grok API.
 *
 * Primary (API key): OpenAI-compatible Chat Completions at
 * `https://api.x.ai/v1/chat/completions`.
 *
 * CLI subscription proxy (OAuth session, future): `cli-chat-proxy.grok.com`.
 *
 * @module llm/providers/grok/wire-constants
 */

/** Base URL for the public xAI API (console API keys). */
export const GROK_API_BASE_URL = "https://api.x.ai"

/** Chat Completions endpoint (OpenAI-compatible). */
export const CHAT_COMPLETIONS_URL = `${GROK_API_BASE_URL}/v1/chat/completions`

/** Responses endpoint (OpenAI-compatible Responses API). */
export const RESPONSES_URL = `${GROK_API_BASE_URL}/v1/responses`

/** Model-list endpoint. */
export const MODELS_URL = `${GROK_API_BASE_URL}/v1/models`

/**
 * CLI chat proxy base (subscription / OIDC session tokens).
 * Used when auth.kind === "oauth".
 */
export const CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com"

export const CLI_CHAT_COMPLETIONS_URL = `${CLI_CHAT_PROXY_BASE_URL}/v1/chat/completions`
export const CLI_RESPONSES_URL = `${CLI_CHAT_PROXY_BASE_URL}/v1/responses`
export const CLI_MODELS_URL = `${CLI_CHAT_PROXY_BASE_URL}/v1/models`
export const CLI_BILLING_URL = `${CLI_CHAT_PROXY_BASE_URL}/v1/billing`

/** User-Agent the adapter advertises. */
export const GROK_USER_AGENT = "minimal-agent-grok/0.1"

/**
 * Session-auth middleware tag required by cli-chat-proxy when using
 * OIDC/session tokens (not required for plain console API keys).
 */
export const XAI_TOKEN_AUTH_HEADER = "X-XAI-Token-Auth"
export const XAI_TOKEN_AUTH_VALUE = "xai-grok-cli"

/** Model routing header used by cli-chat-proxy inference clusters. */
export const GROK_MODEL_OVERRIDE_HEADER = "x-grok-model-override"

/**
 * Client version header required by cli-chat-proxy.
 * Must be \>= 0.1.202 or the proxy rejects the request with 426.
 * We match the installed grok CLI version so the proxy sees a valid client.
 */
export const GROK_CLIENT_VERSION_HEADER = "x-grok-client-version"
export const GROK_CLIENT_VERSION = "0.2.93"

/** Client identifier header sent to cli-chat-proxy (mirrors grok CLI's "grok-shell"). */
export const GROK_CLIENT_IDENTIFIER_HEADER = "x-grok-client-identifier"
export const GROK_CLIENT_IDENTIFIER = "grok-shell"
