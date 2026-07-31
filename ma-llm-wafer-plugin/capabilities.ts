/**
 * Capability tables per Wafer model.
 *
 * Each model's capabilities are derived from the live `GET /v1/models`
 * response (the `wafer.capabilities` field) and mapped to the canonical
 * {@link Capabilities} shape. Snapshot date: 2026-07-30.
 *
 * Mapping (live → Capabilities):
 * - `context_length` / `max_model_len` → `contextWindow`
 * - `capabilities.vision` / `messages.vision` → `modalities.image`
 * - `capabilities.tools` + `*.tool_streaming` → `tools.*`
 * - `capabilities.reasoning` / `messages.reasoning` → `thinking.adaptive` + `visible`
 * - `chat_completions.json_schema` / `responses.text_format` → `structuredOutputs`
 * - `pricing.cache_read_*` present → automatic caching + `reportsCacheHits`
 * - high-TPS `*-fast` SKUs → `speedFast`
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

const THINKING_REASONING = {
  adaptive: true,
  extended: false,
  visible: true,
  interleaved: false,
} as const

const EFFORT_LMH = {
  levels: ["low", "medium", "high"] as const,
  default: "medium" as const,
}

/** Shared OpenAI-Chat sampling / system defaults for Wafer gateway models. */
function baseWaferCaps(
  overrides: Partial<Capabilities> &
    Pick<Capabilities, "contextWindow" | "speedFast" | "modalities">,
): Capabilities {
  return {
    ...defaultCapabilities(),
    maxOutputTokens: 8_192,
    maxOutputTokensBatch: null,
    thinking: { ...THINKING_REASONING },
    effort: { levels: [...EFFORT_LMH.levels], default: EFFORT_LMH.default },
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: false,
    acceptsSeed: false,
    acceptsStopSequences: true,
    caching: { ...CACHING_AUTO },
    tools: { ...TOOLS_FULL },
    midConversationSystem: true,
    structuredOutputs: true,
    assistantPrefill: false,
    serverSideHistory: false,
    serverTools: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// GLM-5.1 — context 202752, vision:false, tools+reasoning, ZDR yes
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_1: Capabilities = baseWaferCaps({
  contextWindow: 202_752,
  speedFast: false,
  modalities: { ...MODALITIES_TEXT },
})

// ---------------------------------------------------------------------------
// GLM-5.2 — context 1048576, vision:false, tools+reasoning, ZDR yes
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_2: Capabilities = baseWaferCaps({
  contextWindow: 1_048_576,
  speedFast: false,
  modalities: { ...MODALITIES_TEXT },
})

// ---------------------------------------------------------------------------
// glm5.2-fast — same family, high-TPS SKU (live display_name GLM5.2-Fast)
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_2_FAST: Capabilities = baseWaferCaps({
  contextWindow: 1_048_576,
  speedFast: true,
  modalities: { ...MODALITIES_TEXT },
})

// ---------------------------------------------------------------------------
// Kimi-K3 — context 912384, vision+tools+reasoning, ZDR yes
// ---------------------------------------------------------------------------

export const CAPS_KIMI_K3: Capabilities = baseWaferCaps({
  contextWindow: 912_384,
  speedFast: false,
  modalities: { image: true, audio: false, pdf: false, video: false },
})

// ---------------------------------------------------------------------------
// kimi-k3-fast — context 1048576, vision+tools+reasoning, high-TPS SKU
// ---------------------------------------------------------------------------

export const CAPS_KIMI_K3_FAST: Capabilities = baseWaferCaps({
  contextWindow: 1_048_576,
  speedFast: true,
  modalities: { image: true, audio: false, pdf: false, video: false },
})

// ---------------------------------------------------------------------------
// Kimi-K2.6 — context 262144, vision+tools+reasoning, ZDR: false
// ---------------------------------------------------------------------------

export const CAPS_KIMI_K2_6: Capabilities = baseWaferCaps({
  contextWindow: 262_144,
  speedFast: false,
  modalities: { image: true, audio: false, pdf: false, video: false },
})

// ---------------------------------------------------------------------------
// MiniMax-M3 — context 1048576, vision+tools+reasoning, ZDR: false
// ---------------------------------------------------------------------------

export const CAPS_MINIMAX_M3: Capabilities = baseWaferCaps({
  contextWindow: 1_048_576,
  speedFast: false,
  modalities: { image: true, audio: false, pdf: false, video: false },
})
