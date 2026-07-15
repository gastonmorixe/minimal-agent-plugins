/**
 * Capability tables per ClinePass model.
 *
 * Sourced from Cline's generated catalog
 * (`sdk/packages/llms/src/catalog/catalog.generated.ts` under `"cline-pass"`)
 * plus product docs. All models speak OpenAI Chat Completions.
 *
 * @module llm/providers/clinepass/capabilities
 */

import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"

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

const MODALITIES_TEXT = {
  image: false,
  audio: false,
  pdf: false,
  video: false,
} as const

const MODALITIES_VISION = {
  image: true,
  audio: false,
  pdf: false,
  video: false,
} as const

const EFFORT_STD = {
  levels: ["low", "medium", "high", "xhigh"] as const,
  default: "medium" as const,
}

function baseReasoning(opts: {
  contextWindow: number
  maxOutputTokens: number
  vision?: boolean
}): Capabilities {
  return {
    ...defaultCapabilities(),
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
    maxOutputTokensBatch: null,
    thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
    effort: { ...EFFORT_STD },
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
    modalities: opts.vision ? { ...MODALITIES_VISION } : { ...MODALITIES_TEXT },
    serverSideHistory: false,
    serverTools: [],
  }
}

/** GLM-5.2 — 1M context, tools + reasoning. */
export const CAPS_GLM_5_2: Capabilities = baseReasoning({
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
})

/** Kimi K2.7 Code — 262K, vision + tools + reasoning. */
export const CAPS_KIMI_K2_7_CODE: Capabilities = baseReasoning({
  contextWindow: 262_144,
  maxOutputTokens: 262_144,
  vision: true,
})

/** Kimi K2.6 — 262K, vision + tools + reasoning. */
export const CAPS_KIMI_K2_6: Capabilities = baseReasoning({
  contextWindow: 262_144,
  maxOutputTokens: 262_144,
  vision: true,
})

/** DeepSeek V4 Pro — 1M context, flagship reasoning. */
export const CAPS_DEEPSEEK_V4_PRO: Capabilities = baseReasoning({
  contextWindow: 1_048_576,
  maxOutputTokens: 384_000,
})

/** DeepSeek V4 Flash — 1M context, cheap scout. */
export const CAPS_DEEPSEEK_V4_FLASH: Capabilities = {
  ...baseReasoning({
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  }),
  speedFast: true,
}

/** MiniMax M3 — 1M context, vision. */
export const CAPS_MINIMAX_M3: Capabilities = {
  ...baseReasoning({
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    vision: true,
  }),
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
}

/** MiMo V2.5 Pro — 1M context. */
export const CAPS_MIMO_V2_5_PRO: Capabilities = baseReasoning({
  contextWindow: 1_048_576,
  maxOutputTokens: 131_072,
})

/** MiMo V2.5 — 1M context, vision, efficient. */
export const CAPS_MIMO_V2_5: Capabilities = {
  ...baseReasoning({
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    vision: true,
  }),
  speedFast: true,
}

/** Qwen3.7 Max — flagship, ~1M context. */
export const CAPS_QWEN3_7_MAX: Capabilities = baseReasoning({
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,
})

/** Qwen3.7 Plus — balanced, vision. */
export const CAPS_QWEN3_7_PLUS: Capabilities = baseReasoning({
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,
  vision: true,
})
