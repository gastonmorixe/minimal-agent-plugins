/**
 * Per-model capability tables for DeepSeek models.
 *
 * Source: DeepSeek API docs (api-docs.deepseek.com), consulted 2026-09-16.
 * Both catalog models share one wire surface (OpenAI Chat Completions) and one
 * capability shape; they differ only in vision support. Ad-hoc / unknown slugs
 * fall back to {@link CAPS_DEEPSEEK_CHAT}.
 *
 * Thinking: DeepSeek returns its chain-of-thought as `reasoning_content`, is
 * enabled by default, and is controlled by the `thinking` toggle plus
 * `reasoning_effort` (`none` disables; `low` / `high` / `max` enable). The docs
 * alias `minimal → low` and `medium` / `xhigh → high`, so the advertised ladder
 * is `none | low | high | max`.
 *
 * @module llm/providers/deepseek/capabilities
 */

import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

/**
 * DeepSeek context caching is automatic and returns cache-hit token counts.
 * No published minimum prefix, so `minPrefixTokens` stays 0 (unknown, not a
 * claimed value).
 */
const CACHING_AUTO = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 0,
  reportsCacheHits: true,
  promptCacheAccounting: "subset" as const,
} as const

/** Tools / function calling. `strict` exists but is documented as beta. */
const TOOLS_FULL = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: false,
} as const

/** Text-only. */
const M_TEXT = { image: false, audio: false, pdf: false, video: false } as const

/** Text + image (DeepSeek V4.1 Flash supports vision; V4 Pro does not). */
const M_TI = { image: true, audio: false, pdf: false, video: false } as const

/**
 * Common DeepSeek Chat surface shape: 1M context, 384K max output, JSON output
 * (not JSON-schema structured outputs), tools, automatic caching.
 */
function deepseekChatBase(modalities: {
  image: boolean
  audio: boolean
  pdf: boolean
  video: boolean
}) {
  return {
    ...defaultCapabilities(),
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    outputTokensShareContextWindow: false,
    maxOutputTokensBatch: null,
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: false,
    acceptsSeed: false,
    acceptsStopSequences: true,
    speedFast: false,
    caching: { ...CACHING_AUTO },
    tools: { ...TOOLS_FULL },
    midConversationSystem: true,
    // DeepSeek documents `response_format: {type: json_object}`, not json_schema.
    structuredOutputs: false,
    assistantPrefill: false,
    modalities: { ...modalities },
    serverSideHistory: false,
    serverTools: [],
  }
}

/** Visible, effort-controlled thinking (`reasoning_content`). */
function thinkDeepSeek() {
  return {
    thinking: { adaptive: false, extended: true, visible: true, interleaved: false } as const,
    effort: { levels: ["none", "low", "high", "max"] as const, default: "high" as const },
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * `deepseek-flash` — currently served by DeepSeek-V4.1-Flash. 1M ctx, 384K out,
 * text + image. Thinking levels `none | low | high | max` (default `high`).
 */
export const CAPS_DEEPSEEK_FLASH: Capabilities = {
  ...deepseekChatBase(M_TI),
  ...thinkDeepSeek(),
}

/**
 * `deepseek-v4-pro` — DeepSeek-V4-Pro-0813. 1M ctx, 384K out, text-only.
 * Thinking levels `none | low | high | max` (default `high`).
 */
export const CAPS_DEEPSEEK_V4_PRO: Capabilities = {
  ...deepseekChatBase(M_TEXT),
  ...thinkDeepSeek(),
}

/**
 * Fallback for ad-hoc slugs the static catalog doesn't know. Text-only, same
 * windows and thinking ladder as the catalog models.
 */
export const CAPS_DEEPSEEK_CHAT: Capabilities = {
  ...deepseekChatBase(M_TEXT),
  ...thinkDeepSeek(),
}
