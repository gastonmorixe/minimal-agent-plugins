/**
 * Per-model capability tables for OpenCode Go models.
 *
 * Three wire surfaces:
 * - **Chat**: OpenAI Chat Completions (`/v1/chat/completions`).
 *   Used by DeepSeek, GLM, Kimi, MiMo, Hy, Grok.
 * - **Messages**: Anthropic Messages (`/v1/messages`).
 *   Used by MiniMax, Qwen.
 * - **Responses**: OpenAI Responses (`/v1/responses`).
 *   Used by GPT-5.6 Luna and Muse Spark 1.2 Contributor.
 *
 * Each model gets its own `Capabilities` record. No bucket presets.
 *
 * Source precedence (2026-08-20):
 * 1. Live IDs from `https://opencode.ai/zen/go/v1/models` (must stay in sync)
 * 2. Context / maxOutput / modalities from models.dev `opencode-go` provider
 * 3. Docs (`opencode.ai/docs/go`) for surface/endpoint mapping; no window sizes
 * 4. Clone only when docs/family imply same shape and secondary sources omit the slug
 *
 * Three wire surfaces:
 * - Chat Completions (`/v1/chat/completions`) — DeepSeek, GLM, Kimi, MiMo, Hy, Grok
 * - Anthropic Messages (`/v1/messages`) — MiniMax, Qwen
 * - OpenAI Responses (`/v1/responses`) — GPT-5.6 Luna, Muse Spark 1.2 Contributor
 *
 * @module llm/providers/opencode/capabilities
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

/** Text + image + audio + pdf (legacy MiMo Omni). */
const M_TIAP = { image: true, audio: true, pdf: true, video: false } as const

/** Text + image + video + audio + pdf. */
const M_ALL = { image: true, audio: true, pdf: true, video: true } as const

/** Text + image + pdf (GPT-5.6 Luna on OpenCode Go). */
const M_TIP = { image: true, audio: false, pdf: true, video: false } as const

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
  levels: ReadonlyArray<"none" | "low" | "medium" | "high"> = ["low", "medium", "high"],
  df: "none" | "low" | "medium" | "high" = "medium",
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
 * DeepSeek V4 Flash — 1M ctx, 384K output, text-only.
 * Caps: models.dev opencode-go (2026-08-05). Surface: docs endpoints table.
 * Efforts: low | high | max (models.dev reasoning_options).
 */
export const CAPS_DEEPSEEK_V4_FLASH: Capabilities = {
  ...chatBase(1_000_000, 384_000, M_TEXT),
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
 * GLM-5.1 — 202_752 ctx, 32_768 output, text-only.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 */
export const CAPS_GLM_5_1: Capabilities = {
  ...chatBase(202_752, 32_768, M_TEXT),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * GLM-5 — deprecated on models.dev; still on live `/v1/models`.
 * Caps: models.dev opencode-go (2026-07-30) — 202_752 ctx / 32_768 out.
 * Not listed on docs/go model list; retained for API ID sync.
 */
export const CAPS_GLM_5: Capabilities = {
  ...chatBase(202_752, 32_768, M_TEXT),
  ...thinkExtended(["medium"], "medium"),
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
 * Kimi K2.6 — 262K ctx, 65_536 output, text+image+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 */
export const CAPS_KIMI_K2_6: Capabilities = {
  ...chatBase(262_144, 65_536, M_TIV),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * Kimi K2.5 — deprecated on models.dev; still on live `/v1/models`.
 * Caps: models.dev opencode-go (2026-07-30). Same multimodal + thinking shape as K2.6.
 */
export const CAPS_KIMI_K2_5: Capabilities = {
  ...chatBase(262_144, 65_536, M_TIV),
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
 * Grok 4.5 — 500K ctx, 500K output, text+image.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 * Efforts: low | medium | high (default high) from models.dev reasoning_options.
 */
export const CAPS_GROK_4_5: Capabilities = {
  ...chatBase(500_000, 500_000, M_TI),
  ...thinkExtended(["low", "medium", "high"], "high"),
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
 * Hy3 Preview — on live `/v1/models` but absent from models.dev and docs/go.
 * Caps cloned from Hy3 (same family / preview slug) until secondary sources
 * publish distinct limits. Do not invent alternate numbers.
 */
export const CAPS_HY3_PREVIEW: Capabilities = {
  ...chatBase(256_000, 64_000, M_TEXT),
  ...thinkExtended(["none", "low", "high"], "high"),
}

/**
 * MiMo V2.5 — 1M ctx, 128K output, text+image+audio+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 */
export const CAPS_MIMO_V2_5: Capabilities = {
  ...chatBase(1_000_000, 128_000, M_TIVA),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * MiMo V2.5 Pro — 1_048_576 ctx, 128K output, text-only.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints table.
 */
export const CAPS_MIMO_V2_5_PRO: Capabilities = {
  ...chatBase(1_048_576, 128_000, M_TEXT),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * MiMo V2 Pro — deprecated on models.dev; still on live `/v1/models`.
 * Caps: models.dev opencode-go (2026-07-30).
 */
export const CAPS_MIMO_V2_PRO: Capabilities = {
  ...chatBase(1_048_576, 128_000, M_TEXT),
  ...thinkExtended(["medium"], "medium"),
}

/**
 * MiMo V2 Omni — deprecated on models.dev; still on live `/v1/models`.
 * Caps: models.dev opencode-go (2026-07-30) — 262K ctx, text+image+audio+pdf.
 */
export const CAPS_MIMO_V2_OMNI: Capabilities = {
  ...chatBase(262_144, 128_000, M_TIAP),
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
 * MiniMax M2.7 — 204_800 ctx, 131K output, text-only.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints (/v1/messages).
 * models.dev lists reasoning with empty options (no toggle) — no `none`.
 */
export const CAPS_MINIMAX_M2_7: Capabilities = {
  ...msgBase(204_800, 131_072, M_TEXT),
  ...thinkAdaptive(),
}

/**
 * MiniMax M2.5 — deprecated on models.dev; still on live `/v1/models` + docs pricing.
 * Caps: models.dev opencode-go (2026-07-30) — 204_800 ctx / 65_536 out.
 * models.dev lists reasoning with empty options (no toggle) — no `none`.
 */
export const CAPS_MINIMAX_M2_5: Capabilities = {
  ...msgBase(204_800, 65_536, M_TEXT),
  ...thinkAdaptive(),
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
 * Qwen3.7 Max — 1M ctx, 65K output, text-only.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints (/v1/messages).
 * Reasoning toggle (models.dev): `--effort none` turns thinking off.
 */
export const CAPS_QWEN3_7_MAX: Capabilities = {
  ...msgBase(1_000_000, 65_536, M_TEXT),
  ...thinkAdaptive(THINK_TOGGLE),
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
 * Qwen3.6 Plus — 1M ctx, 65K output, text+image+video.
 * Caps: models.dev opencode-go (2026-07-30). Surface: docs endpoints (/v1/messages).
 * Reasoning toggle (models.dev): `--effort none` turns thinking off.
 */
export const CAPS_QWEN3_6_PLUS: Capabilities = {
  ...msgBase(1_000_000, 65_536, M_TIV),
  ...thinkAdaptive(THINK_TOGGLE),
}

/**
 * Qwen3.5 Plus — deprecated on models.dev; still on live `/v1/models`.
 * Caps: models.dev opencode-go (2026-07-30) — 262K ctx / 65K out.
 * Reasoning toggle (models.dev): `--effort none` turns thinking off.
 */
export const CAPS_QWEN3_5_PLUS: Capabilities = {
  ...msgBase(262_144, 65_536, M_TIV),
  ...thinkAdaptive(THINK_TOGGLE),
}

// ===========================================================================
// OpenAI Responses surface models
// ===========================================================================

/**
 * Muse Spark 1.2 Contributor — 1.05M ctx, 128K output, multimodal.
 * Caps: models.dev opencode-go (2026-08-20). Surface: docs endpoints
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
