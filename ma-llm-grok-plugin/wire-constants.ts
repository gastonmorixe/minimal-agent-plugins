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
/**
 * Enriched model catalog (same payload as /models plus supported_in_api,
 * hidden, agent_type, laziness_detector). Preferred over /models for OAuth.
 */
export const CLI_MODELS_V2_URL = `${CLI_CHAT_PROXY_BASE_URL}/v1/models-v2`
export const CLI_BILLING_URL = `${CLI_CHAT_PROXY_BASE_URL}/v1/billing`
/**
 * Unified weekly billing (`creditUsagePercent`, `productUsage`,
 * `currentPeriod.type=USAGE_PERIOD_TYPE_WEEKLY`). Verified 2026-08-21.
 */
export const CLI_BILLING_CREDITS_URL = `${CLI_BILLING_URL}?format=credits`

/** OIDC userinfo (email, name, picture). */
export const GROK_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo"

/** Web session identity (userId, xUserId, org fields). */
export const GROK_WEB_SESSION_URL = "https://grok.com/api/auth/session"

/** Subscriptions list (tier / status / provider). */
export const GROK_SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions"

/** User-Agent the adapter advertises. Version tracks the grok CLI crate. */
export const GROK_USER_AGENT = "minimal-agent-grok/1.0.30"

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
 * Matches installed grok CLI (`grok --version` → 1.0.30 / 04b7ffed98c6).
 * grok-build source crate may lag (1.0.24 as of this tree).
 */
export const GROK_CLIENT_VERSION_HEADER = "x-grok-client-version"
export const GROK_CLIENT_VERSION = "1.0.30"

/** Client identifier header sent to cli-chat-proxy (mirrors grok CLI's "grok-shell"). */
export const GROK_CLIENT_IDENTIFIER_HEADER = "x-grok-client-identifier"
export const GROK_CLIENT_IDENTIFIER = "grok-shell"

/** Session / conversation / request routing headers used by grok-build. */
export const GROK_SESSION_ID_HEADER = "x-grok-session-id"
export const GROK_CONV_ID_HEADER = "x-grok-conv-id"
export const GROK_REQ_ID_HEADER = "x-grok-req-id"
export const GROK_AGENT_ID_HEADER = "x-grok-agent-id"
export const GROK_CLIENT_MODE_HEADER = "x-grok-client-mode"
export const GROK_COMPACTION_AT_HEADER = "x-compaction-at"
export const GROK_COMPACTIONS_REMAINING_HEADER = "x-compactions-remaining"

/** Baked grok-4.6/4.5 auto-compact threshold (percent of context window). */
export const GROK_AUTO_COMPACT_THRESHOLD_PERCENT = 80
/** Baked `compactions_remaining` for grok-4.6/4.5. */
export const GROK_COMPACTIONS_REMAINING = "1"

/** Identity headers required on every cli-chat-proxy OAuth request. */
export function grokCliProxyIdentityHeaders(): Record<string, string> {
  return {
    [XAI_TOKEN_AUTH_HEADER]: XAI_TOKEN_AUTH_VALUE,
    "x-authenticateresponse": "authenticate-response",
    [GROK_CLIENT_VERSION_HEADER]: GROK_CLIENT_VERSION,
    [GROK_CLIENT_IDENTIFIER_HEADER]: GROK_CLIENT_IDENTIFIER,
  }
}
