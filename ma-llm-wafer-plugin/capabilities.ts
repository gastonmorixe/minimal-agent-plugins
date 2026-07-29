/**
 * Capability tables per Wafer model.
 *
 * Each model's capabilities are derived from the live `GET /v1/models`
 * response (the `wafer.capabilities` field) and mapped to the canonical
 * {@link Capabilities} shape.
 *
 * All models speak the OpenAI Chat Completions surface
 * (`"openai-chat-completions"`), so these capability records define the
 * settings the shared OpenAI wire layer should use for each model.
 *
 * @module llm/providers/wafer/capabilities
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

const MODALITIES_TEXT = {
  image: false,
  audio: false,
  pdf: false,
  video: false,
} as const

// ---------------------------------------------------------------------------
// GLM-5.1 — 202K context, reasoning with reasoning_content, tools + vision: no
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_1: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 202_752,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// GLM-5.2 — 1,048,576 context, reasoning, tools, vision: no
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_2: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_048_576,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// glm5.2-fast — same family as GLM-5.2, high-TPS / speed-oriented SKU
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_2_FAST: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_048_576,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: true,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Kimi-K2.6 — 262K context, vision + tools + reasoning
// ---------------------------------------------------------------------------

export const CAPS_KIMI_K2_6: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 262_144,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { image: true, audio: false, pdf: false, video: false },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Qwen3.5-397B-A17B — 262K context, massive MoE, reasoning, tools
// ---------------------------------------------------------------------------

export const CAPS_QWEN3_5_397B: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 262_144,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// MiniMax-M3 — 1M context, vision + inline <think> reasoning
// ---------------------------------------------------------------------------

export const CAPS_MINIMAX_M3: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_048_576,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { image: true, audio: false, pdf: false, video: false },
  serverSideHistory: false,
  serverTools: [],
}
