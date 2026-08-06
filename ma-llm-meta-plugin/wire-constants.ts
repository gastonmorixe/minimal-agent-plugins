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
