/**
 * Wire constants for the DeepSeek API.
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions API at
 * `https://api.deepseek.com/chat/completions` (note: no `/v1` prefix — the
 * docs' OpenAI base URL is `https://api.deepseek.com`, and the SDK appends
 * `/chat/completions`). An Anthropic-compatible surface also exists at
 * `https://api.deepseek.com/anthropic`; this plugin only wires Chat.
 *
 * Auth: an API key (`Authorization: Bearer …`), stored via the login command.
 *
 * @module llm/providers/deepseek/wire-constants
 */

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com"

export const CHAT_COMPLETIONS_PATH = "/chat/completions"
export const MODELS_PATH = "/models"

export const CHAT_COMPLETIONS_URL = `${DEEPSEEK_BASE_URL}${CHAT_COMPLETIONS_PATH}`

/**
 * OpenAI-compatible model-listing endpoint (auth required). Returns a JSON
 * object with a `data` array, one entry per model the account can call. Used by
 * the `listLiveModels` hook so the picker shows the authoritative server
 * catalog, not just the static snapshot in `./models.ts`.
 */
export const MODELS_URL = `${DEEPSEEK_BASE_URL}${MODELS_PATH}`

/** User-Agent the adapter advertises. */
export const DEEPSEEK_USER_AGENT = "minimal-agent-deepseek/0.1"
