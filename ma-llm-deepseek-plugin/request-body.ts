/**
 * DeepSeek Chat Completions request body.
 *
 * DeepSeek is OpenAI-Chat-compatible, so the bulk of the body comes from the
 * shared `buildOpenAIChatBody`. Two DeepSeek-specific adjustments are layered
 * on top:
 *
 * 1. `max_tokens` instead of `max_completion_tokens` — the shared builder
 *    switches to the OpenAI reasoning-model field for models that declare an
 *    effort ladder, but DeepSeek documents `max_tokens`.
 * 2. An explicit `thinking: { type }` toggle — DeepSeek enables thinking by
 *    default and accepts `{"thinking":{"type":"enabled"|"disabled"}}`. `none`
 *    effort disables it; every other effort (or no effort) enables it.
 *
 * The chain-of-thought round-trip (`reasoning_content` on assistant messages)
 * is handled by this plugin's vendored `lib/openai-chat.ts`, which echoes
 * canonical `thinking` blocks back onto the wire when tools are present.
 *
 * @module llm/providers/deepseek/request-body
 */

import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelView } from "./lib/host-types.ts"
import { buildOpenAIChatBody, type OpenAIChatRequestBody } from "./lib/openai-chat.ts"

/** OpenAI Chat body plus DeepSeek's `thinking` toggle. */
export interface DeepSeekChatRequestBody extends OpenAIChatRequestBody {
  thinking?: { type: "enabled" | "disabled" }
}

/**
 * Build the DeepSeek Chat Completions request body from a canonical request.
 *
 * @param req - Canonical request.
 * @param model - Resolved model entry (capabilities gate the fields).
 */
export function buildDeepSeekChatBody(
  req: CanonicalRequest,
  model: ModelView,
): DeepSeekChatRequestBody {
  const body = buildOpenAIChatBody(req, model) as DeepSeekChatRequestBody

  // DeepSeek documents `max_tokens`; the shared builder emits
  // `max_completion_tokens` for reasoning-capable models. Translate.
  if (body.max_completion_tokens !== undefined) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  }

  // Explicit thinking toggle. DeepSeek defaults to enabled; `--effort none`
  // is the documented way to disable it (mirrored here for clarity so the
  // intent is visible on the wire even when effort is omitted).
  body.thinking = { type: req.effort === "none" ? "disabled" : "enabled" }

  return body
}
