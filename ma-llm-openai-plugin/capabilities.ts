/**
 * Capability tables per OpenAI model.
 *
 * Two surfaces:
 * - **chat**: Chat Completions API (`/v1/chat/completions`). Mature,
 *   used by every gpt-4 family member and o1/o3/o4-mini.
 * - **responses**: Responses API (`/v1/responses`). Preferred for
 *   gpt-5 family and the new reasoning models. Stateful via
 *   `previous_response_id`, surfaces `reasoning_summary` deltas.
 *
 * Capability fields specific to OpenAI:
 * - `tools.strictSchema = true` (OpenAI honors `strict:true`).
 * - `caching.automatic = true` (server caches the prefix without hints).
 * - `caching.explicit = false` (no `cache_control` markers).
 * - `thinking.adaptive` only on reasoning models AND Responses surface
 *   (Chat exposes `reasoning_effort` but doesn't stream reasoning back).
 *
 * @module llm/providers/openai/capabilities
 */

import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

const CACHING_AUTO = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 1024,
  reportsCacheHits: true,
  promptCacheAccounting: "subset" as const,
}

const TOOLS_FULL = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: true,
}

const MODALITIES_TEXT_IMAGE = {
  image: true,
  audio: false,
  pdf: false,
  video: false,
}

const MODALITIES_TEXT_IMAGE_AUDIO = {
  image: true,
  audio: true,
  pdf: false,
  video: false,
}

// ---------------------------------------------------------------------------
// Chat Completions surface
// ---------------------------------------------------------------------------

/**
 * gpt-4o family on Chat Completions. The everyday workhorse.
 * Accepts sampling, no thinking, automatic prefix caching.
 */
export const CAPS_GPT_4O_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  effort: { levels: [], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: true,
  acceptsStopSequences: true,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_AUDIO },
  serverSideHistory: false,
  serverTools: [],
}

/** gpt-4o-mini on Chat Completions. Cheap + fast. */
export const CAPS_GPT_4O_MINI_CHAT: Capabilities = {
  ...CAPS_GPT_4O_CHAT,
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  modalities: { ...MODALITIES_TEXT_IMAGE },
}

/** gpt-4.1 on Chat Completions. */
export const CAPS_GPT_41_CHAT: Capabilities = {
  ...CAPS_GPT_4O_CHAT,
  contextWindow: 1_000_000,
  maxOutputTokens: 32_768,
}

/**
 * o3 / o4-mini reasoning models on Chat Completions.
 * Accept `reasoning_effort` but no `temperature` / `top_p`.
 * Reasoning tokens billed but not streamed visibly.
 */
export const CAPS_O3_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 200_000,
  maxOutputTokens: 100_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: false,
  serverTools: [],
}

export const CAPS_O4_MINI_CHAT: Capabilities = { ...CAPS_O3_CHAT }

// ---------------------------------------------------------------------------
// Responses surface
// ---------------------------------------------------------------------------

/**
 * gpt-5 on the Responses API. Adaptive-like reasoning, visible reasoning
 * summary deltas, stateful via `previous_response_id`, server-side tools
 * (`web_search_preview`, `file_search`, `code_interpreter`, `computer_use`).
 */
export const CAPS_GPT_5_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 400_000,
  maxOutputTokens: 200_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_AUDIO, pdf: true },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter", "computer_use"],
}

/** gpt-5-thinking — same model id family, opt into deeper reasoning. */
export const CAPS_GPT_5_THINKING_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_RESPONSES,
}

/** o3 on Responses. Same model behavior as Chat variant but with reasoning visibility. */
export const CAPS_O3_RESPONSES: Capabilities = {
  ...CAPS_O3_CHAT,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter"],
}

/** o4-mini on Responses. */
export const CAPS_O4_MINI_RESPONSES: Capabilities = { ...CAPS_O3_RESPONSES }

// ---------------------------------------------------------------------------
// GPT-5.6 family (current GPT-5 generation; Responses preferred, Chat also works)
// ---------------------------------------------------------------------------

/**
 * GPT-5.6 Sol is the frontier tier. The public docs say the short `gpt-5.6`
 * alias routes to this model, so the registry exposes `gpt-5.6` as an alias
 * on the Responses entry and `gpt-5.6-chat` on the Chat entry.
 *
 * Sourced from developers.openai.com/api/docs/models/gpt-5.6-sol and the
 * GPT-5.6 migration guide. The levels are the exact OpenAI API vocabulary
 * for this model, including `none` and `max`.
 *
 * API notes not yet represented in the host capability schema: programmatic
 * tool calling, beta multi-agent, persisted reasoning, pro mode, and
 * `text.verbosity`.
 */
export const CAPS_GPT_5_6_SOL_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter"],
}

/** GPT-5.6 Sol on Chat Completions. Reasoning effort is accepted, but summaries are not streamed. */
export const CAPS_GPT_5_6_SOL_CHAT: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  serverSideHistory: false,
  serverTools: [],
}

/** GPT-5.6 Terra is the balanced intelligence/cost tier. */
export const CAPS_GPT_5_6_TERRA_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
}

/** GPT-5.6 Terra on Chat Completions. */
export const CAPS_GPT_5_6_TERRA_CHAT: Capabilities = {
  ...CAPS_GPT_5_6_SOL_CHAT,
}

/** GPT-5.6 Luna is the high-volume, low-cost tier. */
export const CAPS_GPT_5_6_LUNA_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
}

/** GPT-5.6 Luna on Chat Completions. */
export const CAPS_GPT_5_6_LUNA_CHAT: Capabilities = {
  ...CAPS_GPT_5_6_SOL_CHAT,
}

// ---------------------------------------------------------------------------
// GPT-5.5 / GPT-5.4 generation
// ---------------------------------------------------------------------------

/** GPT-5.5 Pro uses more compute for difficult Responses API work. */
export const CAPS_GPT_5_5_PRO_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
  effort: { levels: ["medium", "high", "xhigh"], default: "high" },
}

/** GPT-5.4 frontier tier. */
export const CAPS_GPT_5_4_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
  effort: { levels: ["none", "low", "medium", "high", "xhigh"], default: "medium" },
}

/** GPT-5.4 on Chat Completions. */
export const CAPS_GPT_5_4_CHAT: Capabilities = {
  ...CAPS_GPT_5_4_RESPONSES,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  serverSideHistory: false,
  serverTools: [],
}

/** GPT-5.4 mini. */
export const CAPS_GPT_5_4_MINI_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_4_RESPONSES,
  contextWindow: 400_000,
}

/** GPT-5.4 mini on Chat Completions. */
export const CAPS_GPT_5_4_MINI_CHAT: Capabilities = {
  ...CAPS_GPT_5_4_CHAT,
  contextWindow: 400_000,
}

/** GPT-5.4 nano. */
export const CAPS_GPT_5_4_NANO_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_4_RESPONSES,
  contextWindow: 400_000,
}

/** GPT-5.4 nano on Chat Completions. */
export const CAPS_GPT_5_4_NANO_CHAT: Capabilities = {
  ...CAPS_GPT_5_4_CHAT,
  contextWindow: 400_000,
}

/**
 * GPT-5.5 on the Responses API. 1.05M context, 128K max output, adaptive
 * reasoning with visible summaries, effort `low|medium|high|xhigh`.
 *
 * Sourced from developers.openai.com/api/docs/models/gpt-5.5 (the live
 * 1,050,000 context + 128K output figures) and the codex `models.json`
 * slug `gpt-5.5` (reasoning levels, `input_modalities`, `prefer_websockets`,
 * `additional_speed_tiers`). Knowledge cutoff 2025-12. The OpenAI "fast"
 * speed tier (`additional_speed_tiers: ["fast"]`) is a vendor extension we
 * do not wire yet, so `speedFast` stays false (no silent wire field).
 *
 * NOTE on the Codex/ChatGPT-OAuth backend: that surface enforces a SMALLER
 * effective window than the model's 1.05M. OpenAI's Codex manifest declares
 * `"context_window": 272000` for gpt-5.5, and Codex defaults to that unless
 * a client opts into the 1M window (model_context_window /
 * model_auto_compact_token_limit). A session under ChatGPT-Codex OAuth hit
 * `context_length_exceeded` at ~267k input tokens (session 870bda04,
 * 2026-06-28) because this single capability value advertises the model's
 * 1.05M to BOTH surfaces, so the budget clamp + context-% UI never saw the
 * tighter 272k Codex ceiling. Fixing that needs a surface/auth-aware window,
 * not a blanket downgrade of the model's true context.
 */
export const CAPS_GPT_5_5_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter"],
}

/**
 * GPT-5.5 on Chat Completions. Same underlying model; `reasoning_effort`
 * is accepted but reasoning is NOT streamed back (no visible summaries),
 * and there is no server-side history or hosted tools on this surface.
 */
export const CAPS_GPT_5_5_CHAT: Capabilities = {
  ...CAPS_GPT_5_5_RESPONSES,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  serverSideHistory: false,
  serverTools: [],
}
