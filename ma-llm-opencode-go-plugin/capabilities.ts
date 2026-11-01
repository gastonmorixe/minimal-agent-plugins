/**
 * Per-model capability tables for OpenCode Go models.
 *
 * Three wire surfaces:
 * - **Chat**: OpenAI Chat Completions (`/v1/chat/completions`).
 *   Used by DeepSeek, GLM, Kimi, MiMo, Hy, LongCat, Beam, Gemini, Iceman, Step.
 * - **Messages**: Anthropic Messages (`/v1/messages`).
 *   Used by MiniMax M3, Qwen, Claude Haiku.
 * - **Responses**: OpenAI Responses (`/v1/responses`).
 *   Used by GPT Luna, Grok, Muse Spark Contributor.
 *
 * Each model gets its own `Capabilities` record. No bucket presets.
 *
 * Source precedence (2026-10-11):
 * 1. Live IDs from `https://opencode.ai/zen/go/v1/models` (must stay in sync)
 * 2. Context / maxOutput / modalities from models.dev `opencode-go` provider
 * 3. Docs (`opencode.ai/docs/go`) for surface/endpoint mapping; no window sizes
 * 4. Clone only when docs/family imply same shape and secondary sources omit the slug
 *
 * @module llm/providers/opencode/capabilities
 */

import {
  type Capabilities,
  defaultCapabilities,
} from "@minimal-agent/core/plugin-api/llm/capabilities"

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

const CACHING_AUTO = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 1024,
  reportsCacheHits: true,
} as const

const TOOLS_FULL = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: false,
} as const

/** Text-only. */
const M_TEXT = { image: false, audio: false, pdf: false, video: false } as const

/** Text + image. */
const M_TI = { image: true, audio: false, pdf: false, video: false } as const

/** Text + image + video. */
const M_TIV = { image: true, audio: false, pdf: false, video: true } as const

/** Text + image + video + audio (omnimodal). */
const M_TIVA = { image: true, audio: true, pdf: false, video: true } as const

/** Text + image + video + audio + pdf. */
const M_ALL = { image: true, audio: true, pdf: true, video: true } as const

/** Text + image + pdf (GPT-5.6 Luna on OpenCode Go). */
const M_TIP = { image: true, audio: false, pdf: true, video: false } as const

/** Text + image + video + pdf (GLM-5.3-Flash). */
const M_TIVP = { image: true, audio: false, pdf: true, video: true } as const

const TOOLS_STRICT = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: true,
} as const

// ---------------------------------------------------------------------------
// Thinking helpers
// ---------------------------------------------------------------------------

/**
 * Extended (budgeted) thinking, visible output. Caller selects a thinking
 * mode before the request; no adaptive toggle.
 *
 * Used by most Chat-surface models (DeepSeek, GLM, Kimi, MiMo).
 */
function thinkExtended(
  levels: ReadonlyArray<"minimal" | "none" | "low" | "medium" | "high" | "xhigh" | "max">,
  df: "none" | "low" | "medium" | "high" | "xhigh" | "max" = "medium",
) {
  return {
    thinking: { adaptive: false, extended: true, visible: true, interleaved: false } as const,
    effort: { levels, default: df } as const,
  }
}

/**
 * OpenAI Responses-style adaptive reasoning with visible interleaved
 * summaries. Used by GPT-5.6 Luna on `/v1/responses`.
 */
function thinkResponses(
  levels: ReadonlyArray<"minimal" | "none" | "low" | "medium" | "high" | "xhigh" | "max">,
  df: "none" | "low" | "medium" | "high" | "xhigh" | "max" = "medium",
) {
  return {
    thinking: { adaptive: true, extended: false, visible: true, interleaved: true } as const,
    effort: { levels, default: df } as const,
  }
}

/**
 * Adaptive thinking for Anthropic Messages surface models.
 * The model decides per-turn whether to think; visible + interleaved
 * (think → text → think → text within one assistant turn).
 *
 * Pass `none` in `levels` when models.dev lists a reasoning **toggle**
 * (Qwen family, MiniMax M3). `--effort none` then maps to thinking off
 * on the wire (omit `thinking`; do not send `output_config.effort:"none"`).
 */
function thinkAdaptive(
  levels: ReadonlyArray<"none" | "low" | "medium" | "high" | "xhigh" | "max"> = [
    "low",
    "medium",
    "high",
  ],
  df: "none" | "low" | "medium" | "high" | "xhigh" | "max" = "medium",
) {
  return {
    thinking: { adaptive: true, extended: false, visible: true, interleaved: true } as const,
    effort: { levels, default: df } as const,
  }
}

/** models.dev `reasoning_options: [{type:"toggle"}, …]` → effort includes none. */
const THINK_TOGGLE = ["none", "low", "medium", "high"] as const

// ---------------------------------------------------------------------------
// Base capability builders
// ---------------------------------------------------------------------------

function chatBase(
  ctx: number,
  maxOut: number,
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean },
) {
  return {
    ...defaultCapabilities(),
    contextWindow: ctx,
    maxOutputTokens: maxOut,
    maxOutputTokensBatch: null,
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
    modalities: { ...modalities },
    serverSideHistory: false,
    serverTools: [],
  }
}

function msgBase(
  ctx: number,
  maxOut: number,
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean },
) {
  return {
    ...defaultCapabilities(),
    contextWindow: ctx,
    maxOutputTokens: maxOut,
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
    structuredOutputs: true,
    assistantPrefill: false,
    modalities: { ...modalities },
    serverSideHistory: false,
    serverTools: [],
  }
}

// ===========================================================================
// OpenAI Chat Completions surface models
// ===========================================================================

/**
 * DeepSeek V4 Pro — 1M ctx, 384K output, text-only.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 * Efforts: high | max only (models.dev). No thinking-off / Non-think level.
 */
export const CAPS_DEEPSEEK_V4_PRO: Capabilities = {
  ...chatBase(1_000_000, 384_000, M_TEXT),
  ...thinkExtended(["high", "max"], "high"),
}

/**
 * DeepSeek V4.1 Flash — 1M ctx, 384K output, text+image.
 * Caps: models.dev opencode-go (2026-09-10). Surface: docs endpoints table.
 * Efforts: low | high | max (models.dev reasoning_options).
 */
export const CAPS_DEEPSEEK_V4_1_FLASH: Capabilities = {
  ...chatBase(1_000_000, 384_000, M_TI),
  ...thinkExtended(["low", "high", "max"], "high"),
}

/**
 * GLM-5.3-Flash — 1M ctx, 131K output, text+image+video+pdf.
 * Caps: models.dev opencode-go (2026-08-26). Surface: docs endpoints table.
 * Efforts: low | high | max (models.dev reasoning_options).
 */
export const CAPS_GLM_5_3_FLASH: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TIVP),
  ...thinkExtended(["low", "high", "max"], "high"),
}

/**
 * GLM-5.3 — 1M ctx, 131K output, text-only.
 * Caps: models.dev opencode-go (2026-08-20). Surface: docs endpoints table.
 * Efforts: low | high | max (models.dev reasoning_options).
 */
export const CAPS_GLM_5_3: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TEXT),
  ...thinkExtended(["low", "high", "max"], "high"),
}

/**
 * GLM-5.2 — 1M ctx, 131K output, text-only.
 * Caps: models.dev opencode-go (2026-08-20). Surface: docs endpoints table.
 */
export const CAPS_GLM_5_2: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TEXT),
  ...thinkExtended(["high", "max"], "high"),
}

/**
 * Kimi K2.7 Code — 262K ctx, 262K output, text+image+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 * Thinking always on (mandatory preserve_thinking).
 */
export const CAPS_KIMI_K2_7_CODE: Capabilities = {
  ...chatBase(262_144, 262_144, M_TIV),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * Kimi K3 — 1_048_576 ctx, 131K output, text+image+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 * Thinking always on; Moonshot exposes reasoning_effort "max" only.
 */
export const CAPS_KIMI_K3: Capabilities = {
  ...chatBase(1_048_576, 131_072, M_TIV),
  ...thinkExtended(["max"], "max"),
}

/**
 * Hy3 — 256K ctx, 64K output, text-only.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 * Efforts: none | low | high ("none" = thinking off / reasoning_effort none).
 */
export const CAPS_HY3: Capabilities = {
  ...chatBase(256_000, 64_000, M_TEXT),
  ...thinkExtended(["none", "low", "high"], "high"),
}

/**
 * Hy4 Preview — 1_024_000 ctx, 64K output, text-only.
 * Caps: models.dev opencode-go (2026-08-28). Surface: docs endpoints table.
 * Efforts: none | high (models.dev reasoning_options).
 */
export const CAPS_HY4_PREVIEW: Capabilities = {
  ...chatBase(1_024_000, 64_000, M_TEXT),
  ...thinkExtended(["none", "high"], "high"),
}

/**
 * LongCat-2.0 — 1M ctx, 131K output, text-only.
 * Caps: models.dev opencode-go (2026-06-30). Surface: docs endpoints table.
 * Reasoning toggle only (models.dev) — map to none | medium on Chat.
 */
export const CAPS_LONGCAT_2_0: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TEXT),
  ...thinkExtended(["none", "medium"], "medium"),
}

/**
 * MiMo V2.6 Flash — 1_048_576 ctx, 131K output, text+image+audio+video.
 * Caps: models.dev opencode-go (2026-09-22). Surface: Chat.
 * models.dev lists reasoning with empty options; single medium level.
 */
export const CAPS_MIMO_V2_6_FLASH: Capabilities = {
  ...chatBase(1_048_576, 131_072, M_TIVA),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * MiMo V2.6 Pro — 1_048_576 ctx, 131K output, text+image+audio+video.
 * Caps: models.dev opencode-go (2026-09-22). Surface: Chat.
 * models.dev lists reasoning with empty options; single medium level.
 */
export const CAPS_MIMO_V2_6_PRO: Capabilities = {
  ...chatBase(1_048_576, 131_072, M_TIVA),
  ...thinkExtended(["medium"], "medium"),
}

// ===========================================================================
// Anthropic Messages surface models
// ===========================================================================

/**
 * MiniMax M3 — 1M ctx, 131K output, text+image+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints (/v1/messages).
 * Reasoning toggle (models.dev): `--effort none` turns thinking off.
 */
export const CAPS_MINIMAX_M3: Capabilities = {
  ...msgBase(1_000_000, 131_072, M_TIV),
  ...thinkAdaptive(THINK_TOGGLE),
}

/**
 * Qwen3.8 Max — 1M ctx, 131K output, text+image+video.
 * Caps: models.dev opencode-go (2026-08-05). Surface: docs endpoints (/v1/messages).
 * Pricing: docs/go + models.dev agree ($2/$6/$0.25/$2.50).
 * Reasoning toggle (models.dev): `--effort none` turns thinking off.
 */
export const CAPS_QWEN3_8_MAX: Capabilities = {
  ...msgBase(1_000_000, 131_072, M_TIV),
  ...thinkAdaptive(THINK_TOGGLE),
}

/**
 * Qwen3.8 Flash — 1M ctx, 131K output, text+image+video.
 * Caps: models.dev opencode-go (2026-08-26). Surface: docs endpoints (/v1/messages).
 * Reasoning toggle + effort low | medium | xhigh (models.dev).
 */
export const CAPS_QWEN3_8_FLASH: Capabilities = {
  ...msgBase(1_000_000, 131_072, M_TIV),
  ...thinkAdaptive(["none", "low", "medium", "xhigh"], "medium"),
}

/**
 * Qwen3.7 Plus — 1M ctx, 65K output, text+image+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints (/v1/messages).
 * Reasoning toggle (models.dev): `--effort none` turns thinking off.
 */
export const CAPS_QWEN3_7_PLUS: Capabilities = {
  ...msgBase(1_000_000, 65_536, M_TIV),
  ...thinkAdaptive(THINK_TOGGLE),
}

/**
 * Claude Haiku 5.5 — 1M ctx, 128K output, text+image+pdf.
 * Caps: models.dev opencode-go (2026-10-07). Surface: Messages (`@ai-sdk/anthropic`).
 * Reasoning toggle + effort low | medium | high | xhigh | max (models.dev).
 */
export const CAPS_CLAUDE_HAIKU_5_5: Capabilities = {
  ...msgBase(1_000_000, 128_000, M_TIP),
  ...thinkAdaptive(["none", "low", "medium", "high", "xhigh", "max"], "medium"),
}

// ===========================================================================
// OpenAI Responses surface models
// ===========================================================================

/**
 * Muse Spark 1.2 Contributor — 1.05M ctx, 131K output, multimodal.
 * Caps: models.dev opencode-go (2026-08-05). Surface: docs endpoints
 * (`/v1/responses`, `@ai-sdk/openai`). Efforts: minimal | low | medium | high | xhigh.
 * OpenCode Go does not advertise server-side tools or stateful history.
 */
export const CAPS_MUSE_SPARK_1_2_CONTRIBUTOR: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_048_576,
  maxOutputTokens: 131_072,
  maxOutputTokensBatch: null,
  ...thinkResponses(["minimal", "low", "medium", "high", "xhigh"], "medium"),
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_STRICT },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...M_ALL },
  serverSideHistory: false,
  serverTools: [],
}

/**
 * Muse Spark 1.3 Contributor — same window/modalities/efforts as 1.2.
 * Caps: models.dev opencode-go (2026-09-02). Surface: docs endpoints
 * (`/v1/responses`, `@ai-sdk/openai`). Keep ID distinct for live catalog sync
 * (error footers use `og-muse-spark-…-contributor:effort`).
 */
export const CAPS_MUSE_SPARK_1_3_CONTRIBUTOR: Capabilities = {
  ...CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
}

/**
 * GPT-5.6 Luna — 1.05M ctx, 128K output, text+image+pdf.
 * Caps: models.dev opencode-go (2026-08-05). Surface: docs endpoints
 * (`/v1/responses`, `@ai-sdk/openai`). Reasoning model: no temperature/top_p.
 * Efforts: none | low | medium | high | xhigh | max (models.dev).
 * Server tools / stateful history are OpenAI-first-party features; OpenCode Go
 * does not advertise them, so keep them off.
 */
export const CAPS_GPT_5_6_LUNA: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  maxOutputTokensBatch: null,
  ...thinkResponses(["none", "low", "medium", "high", "xhigh", "max"], "medium"),
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_STRICT },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...M_TIP },
  serverSideHistory: false,
  serverTools: [],
}

/**
 * GPT-6 Luna — 1.05M ctx, 128K output, text+image+pdf.
 * Caps: models.dev opencode-go (2026-09-22). Surface: Responses (`@ai-sdk/openai`).
 * Reasoning model: no temperature/top_p (models.dev).
 * Efforts: none | low | medium | high | xhigh | max (models.dev).
 */
export const CAPS_GPT_6_LUNA: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  maxOutputTokensBatch: null,
  ...thinkResponses(["none", "low", "medium", "high", "xhigh", "max"], "medium"),
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_STRICT },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...M_TIP },
  serverSideHistory: false,
  serverTools: [],
}

/**
 * Grok 4.7 — 500K ctx, 500K output, text+image+pdf on Responses.
 * Caps: models.dev opencode-go (2026-09-21). Surface: Responses (Assumed,
 * same as Grok 4.6; docs/go endpoint table unreachable at refresh time).
 * Efforts: low | medium | high | xhigh (default high). Accepts temperature.
 */
export const CAPS_GROK_4_7: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 500_000,
  maxOutputTokens: 500_000,
  maxOutputTokensBatch: null,
  ...thinkResponses(["low", "medium", "high", "xhigh"], "high"),
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_STRICT },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...M_TIP },
  serverSideHistory: false,
  serverTools: [],
}

/**
 * Beam Free — 1_048_576 ctx, 131_072 output, text-only.
 * Caps: models.dev opencode-go (2026-10-16). Surface: Chat (provider api
 * `.../openai/v1`). Efforts: low | medium | high | xhigh | max (models.dev).
 */
export const CAPS_BEAM_FREE: Capabilities = {
  ...chatBase(1_048_576, 131_072, M_TEXT),
  ...thinkExtended(["low", "medium", "high", "xhigh", "max"], "medium"),
}

/**
 * Gemini 4 Argon — 1_048_576 ctx, 65_536 output, omnimodal input.
 * Caps: models.dev opencode-go (2026-10-13). Surface: Chat (same routing as
 * the Zen sibling, whose gemini family also rides the Chat translator).
 * Efforts: low | medium | high (models.dev reasoning_options).
 */
export const CAPS_GEMINI_4_ARGON: Capabilities = {
  ...chatBase(1_048_576, 65_536, M_ALL),
  ...thinkExtended(["low", "medium", "high"], "medium"),
  acceptsTemperature: false,
}

/**
 * Iceman Contributor Free — 262_144 ctx, 131_072 output, text-only.
 * Caps: models.dev opencode-go (2026-10-24). Surface: Chat (provider api
 * `.../openai/v1`). models.dev lists reasoning with empty options; single
 * medium level.
 */
export const CAPS_ICEMAN_CONTRIBUTOR_FREE: Capabilities = {
  ...chatBase(262_144, 131_072, M_TEXT),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * Kimi K3.1 Pro — 1_048_576 ctx, 131_072 output, text+image+video.
 * Caps: models.dev opencode-go (2026-10-23). Surface: Chat (provider api
 * `.../openai/v1`). Efforts: low | high | max (models.dev reasoning_options).
 */
export const CAPS_KIMI_K3_1_PRO: Capabilities = {
  ...chatBase(1_048_576, 131_072, M_TIV),
  ...thinkExtended(["low", "high", "max"], "high"),
  acceptsTemperature: false,
}

/**
 * MiniMax M3.1 Flash — 1M ctx, 512K output, text+image+video.
 * Caps: models.dev opencode-go (2026-10-19). Surface: Chat (provider api
 * `.../openai/v1`). Efforts: low | medium | high | xhigh | max (models.dev).
 */
export const CAPS_MINIMAX_M3_1_FLASH: Capabilities = {
  ...chatBase(1_000_000, 512_000, M_TIV),
  ...thinkExtended(["low", "medium", "high", "xhigh", "max"], "medium"),
}

/**
 * Step 5 Preview — 1M ctx, 65_536 output, text+image+video.
 * Caps: models.dev opencode-go (2026-09-20). Surface: Chat (provider api
 * `.../openai/v1`). Efforts: low | medium | high (models.dev).
 */
export const CAPS_STEP_5_PREVIEW: Capabilities = {
  ...chatBase(1_000_000, 65_536, M_TIV),
  ...thinkExtended(["low", "medium", "high"], "medium"),
}

// ---------------------------------------------------------------------------
// Fallbacks for ad-hoc / dynamically-discovered models
// ---------------------------------------------------------------------------

/**
 * Conservative fallback for ad-hoc Chat-surface models.
 * 128K ctx, 16K output, text-only, single thinking level.
 */
export const CAPS_OPENCODE_CHAT_FALLBACK: Capabilities = {
  ...chatBase(128_000, 16_384, M_TEXT),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * Conservative fallback for ad-hoc Messages-surface models.
 * 128K ctx, 16K output, text-only, adaptive thinking.
 */
export const CAPS_OPENCODE_MESSAGES_FALLBACK: Capabilities = {
  ...msgBase(128_000, 16_384, M_TEXT),
  ...thinkAdaptive(),
}
