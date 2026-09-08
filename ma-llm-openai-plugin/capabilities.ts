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

/** gpt-4.1 on Chat Completions. Docs: 1,047,576 context (2026-07-30). */
export const CAPS_GPT_41_CHAT: Capabilities = {
  ...CAPS_GPT_4O_CHAT,
  contextWindow: 1_047_576,
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
 * summary deltas, stateful via `previous_response_id`. Docs (2026-07-30):
 * 400K context, 128K max output, effort `minimal|low|medium|high`, text+image.
 * Sourced from developers.openai.com/api/docs/models/gpt-5.
 */
export const CAPS_GPT_5_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["minimal", "low", "medium", "high"], default: "medium" },
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
// GPT-6 Astra (current flagship; Responses preferred, Chat also works)
// ---------------------------------------------------------------------------

/**
 * GPT-6 Astra is the current flagship. Sourced 2026-09-08 from
 * developers.openai.com/api/docs/models/gpt-6-astra and ChatGPT-Codex
 * `GET /backend-api/codex/models?client_version=1.0.0` (credential
 * `openai-chatgpt-oauth-4`, plan plus).
 *
 * Public API effort: `low|medium|high|xhigh|max`. Codex also lists `ultra`
 * (multi-agent delegation) and Fast via `service_tiers[{id:"priority"}]` +
 * `additional_speed_tiers:["fast"]` (2x speed). Docs do **not** list `none`
 * for Astra (unlike Sol). Codex default effort is `low`.
 *
 * ChatGPT consumer work-mode slug `gpt-6-astra-wm` maps here. Do not register
 * hidden Codex `gpt-reserve` / `codex-auto-review`. Codex compact ceilings
 * (272k / 872k) must not overwrite the API 1.05M contextWindow.
 */
export const CAPS_GPT_6_ASTRA_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: {
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    default: "low",
  },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  // Codex: Fast is 2x for Astra (wire value still `priority`).
  speedFast: true,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter", "computer_use"],
}

/** GPT-6 Astra on Chat Completions. Effort accepted; summaries not streamed. */
export const CAPS_GPT_6_ASTRA_CHAT: Capabilities = {
  ...CAPS_GPT_6_ASTRA_RESPONSES,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// GPT-5.6 family (previous GPT-5 generation; Responses preferred, Chat also works)
// ---------------------------------------------------------------------------

/**
 * GPT-5.6 Sol is the GPT-5.6 frontier tier. The public docs say the short
 * `gpt-5.6` alias routes to this model, so the registry exposes `gpt-5.6` as
 * an alias on the Responses entry and `gpt-5.6-chat` on the Chat entry.
 *
 * Sourced 2026-07-30 from developers.openai.com/api/docs/models/gpt-5.6-sol
 * (+ Terra/Luna siblings) and the GPT-5.6 migration guide. Reconfirmed
 * 2026-08-18 against ChatGPT-Codex `GET /backend-api/codex/models` (credential
 * `openai-chatgpt-oauth-3`, plan prolite) and again 2026-09-08 with
 * `openai-chatgpt-oauth-4` (`client_version=1.0.0`). Codex Fast is
 * `service_tiers[{id:"priority", name:"Fast"}]` + `additional_speed_tiers:["fast"]`.
 * Codex effort ladder for Sol/Terra is `low|medium|high|xhigh|max|ultra`
 * (Sol default `low`; Terra default `medium`). Keep API `none` as well —
 * public docs still list it; do not drop it just because Codex omits it.
 *
 * ChatGPT OAuth live: consumer slugs `gpt-5-6` / `gpt-5-6-instant` /
 * `gpt-5-6-thinking` and work-mode `gpt-5.6-sol-wm` map here. Consumer
 * efforts `min|standard|extended|max` must not replace this API ladder.
 * Consumer `max_tokens` is a UI budget (Thinking 262144), not this 1.05M
 * API contextWindow. ChatGPT Pro lane `gpt-5-6-pro` is **not** a separate
 * API model id; docs say enable Pro via Responses `reasoning.mode: "pro"`.
 * Codex `context_window` 272000 / `max_context_window` 872000 is the Codex
 * compact ceiling, not a reason to downgrade the API window.
 *
 * API notes not yet represented in the host capability schema: programmatic
 * tool calling, beta multi-agent, persisted reasoning, pro mode
 * (`reasoning.mode`), and `text.verbosity`.
 */
export const CAPS_GPT_5_6_SOL_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: {
    levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
    default: "medium",
  },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  // Codex catalog: service_tiers[{id:"priority", name:"Fast"}] +
  // additional_speed_tiers:["fast"]. Wire value is still `priority`.
  speedFast: true,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter", "computer_use"],
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

/**
 * GPT-5.6 Luna is the high-volume, low-cost tier. Codex live (2026-08-18)
 * lists Fast + efforts `low|medium|high|xhigh|max` — no `ultra` (that is
 * Sol/Terra only). Keep API `none`. Consumer mini slugs `gpt-5-6-mini` /
 * `gpt-5-6-t-mini` title as Luna.
 */
export const CAPS_GPT_5_6_LUNA_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
  effort: { levels: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
}

/** GPT-5.6 Luna on Chat Completions. */
export const CAPS_GPT_5_6_LUNA_CHAT: Capabilities = {
  ...CAPS_GPT_5_6_LUNA_RESPONSES,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// GPT-5.5 / GPT-5.4 generation
// ---------------------------------------------------------------------------

/**
 * GPT-5.5 Pro uses more compute for difficult Responses API work.
 * Docs (2026-07-30): effort `medium|high|xhigh` (default high), 1.05M context.
 * ChatGPT slug `gpt-5-5-pro` maps here; consumer Pro efforts were only
 * `standard|extended` — keep the API ladder, do not import consumer labels.
 * ChatGPT advertised max_tokens 410000 (consumer UI), not API contextWindow.
 */
export const CAPS_GPT_5_5_PRO_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_6_SOL_RESPONSES,
  effort: { levels: ["medium", "high", "xhigh"], default: "high" },
}

/**
 * GPT-5.4 Pro — Responses only. Effort `medium|high|xhigh` (default high).
 * Sourced 2026-07-30 from developers.openai.com/api/docs/models/gpt-5.4-pro.
 */
export const CAPS_GPT_5_4_PRO_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_5_PRO_RESPONSES,
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

/** GPT-5.4 mini. Codex catalog: no Fast / priority service tier. */
export const CAPS_GPT_5_4_MINI_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_4_RESPONSES,
  contextWindow: 400_000,
  speedFast: false,
}

/** GPT-5.4 mini on Chat Completions. */
export const CAPS_GPT_5_4_MINI_CHAT: Capabilities = {
  ...CAPS_GPT_5_4_CHAT,
  contextWindow: 400_000,
  speedFast: false,
}

/** GPT-5.4 nano. Codex catalog: no Fast / priority service tier. */
export const CAPS_GPT_5_4_NANO_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_4_RESPONSES,
  contextWindow: 400_000,
  speedFast: false,
}

/** GPT-5.4 nano on Chat Completions. */
export const CAPS_GPT_5_4_NANO_CHAT: Capabilities = {
  ...CAPS_GPT_5_4_CHAT,
  contextWindow: 400_000,
  speedFast: false,
}

/**
 * GPT-5.5 on the Responses API. 1.05M context, 128K max output, adaptive
 * reasoning with visible summaries, effort `low|medium|high|xhigh`.
 *
 * Sourced 2026-07-30 from developers.openai.com/api/docs/models/gpt-5.5
 * (1,050,000 context + 128K output). Knowledge cutoff 2025-12-01. Codex Fast
 * mode (`/fast`) is this model's catalog Fast tier (wire id `priority`,
 * display name Fast) plus `additional_speed_tiers: ["fast"]`. `--fast` /
 * `speed:"fast"` maps to wire `service_tier: "priority"` (Codex
 * `ServiceTier.Fast.request_value()`), not Anthropic's `speed:"fast"` body
 * field.
 *
 * ChatGPT OAuth live (2026-08-18): default picker slug `gpt-5-5`; Instant /
 * Thinking lanes `gpt-5-5-instant` / `gpt-5-5-thinking` are UI variants of
 * this API id (not separate registrations). Consumer Thinking efforts
 * `min|standard|extended|max` must not replace the API ladder above.
 * Consumer max_tokens: Instant/auto ~137000, Thinking ~410000 — UI limits
 * only; keep API contextWindow at 1.05M.
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
  speedFast: true,
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
