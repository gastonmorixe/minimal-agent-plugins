/**
 * Capability tables for the Antigravity models.
 *
 * Source: `fetchAvailableModels` of the live account
 * (`evidence/fetchAvailableModels.json` in the worktree research folder) and
 * `fetchConfig` for the non-Gemini families. Refreshed 2026-11-25.
 *
 * Every model uses one shared wire surface (`custom`): the Cloud Code Assist
 * envelope with `contents` / `parts`. The family only changes the thinking
 * field name (`thinkingLevel` for Gemini and Claude, `thinkingBudget` for
 * GPT-OSS) and the limits.
 *
 * @module llm/providers/antigravity/capabilities
 */

import {
  type Capabilities,
  defaultCapabilities,
} from "@minimal-agent/core/plugin-api/llm/capabilities"

const TOOLS_WHOLE_CALL = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: false,
  toolChoice: true,
  strictSchema: false,
} as const

const CACHING_IMPLICIT = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 1024,
  reportsCacheHits: true,
} as const

const MODALITIES_VISION = {
  image: true,
  audio: false,
  pdf: true,
  video: false,
} as const

const MODALITIES_TEXT = {
  image: false,
  audio: false,
  pdf: false,
  video: false,
} as const

const EFFORT_LMH = {
  levels: ["low", "medium", "high"] as const,
  default: "medium" as const,
}

const EFFORT_LMHX = {
  levels: ["low", "medium", "high", "xhigh"] as const,
  default: "medium" as const,
}

/** Image formats the backend accepts for a vision model. */
export const ANTIGRAVITY_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]

interface FamilyOptions {
  contextWindow: number
  maxOutputTokens: number
  vision?: boolean
  thinking?: boolean
  effort?: { levels: readonly string[]; default: string }
  imageOutput?: boolean
}

function family(opts: FamilyOptions): Capabilities {
  const thinkingOn = opts.thinking !== false
  return {
    ...defaultCapabilities(),
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
    maxOutputTokensBatch: null,
    outputTokensShareContextWindow: false,
    thinking: {
      adaptive: thinkingOn,
      extended: thinkingOn,
      visible: thinkingOn,
      interleaved: false,
    },
    effort: { ...(opts.effort ?? EFFORT_LMH) },
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: true,
    acceptsSeed: false,
    acceptsStopSequences: true,
    speedFast: false,
    caching: { ...CACHING_IMPLICIT },
    tools: { ...TOOLS_WHOLE_CALL },
    midConversationSystem: false,
    structuredOutputs: false,
    assistantPrefill: false,
    modalities: { ...(opts.vision ? MODALITIES_VISION : MODALITIES_TEXT) },
    serverSideHistory: false,
    serverTools: [],
    priorThinking: "keep-all",
  }
}

/**
 * A copy of `caps` with the effort levels of one catalog row.
 *
 * The family table gives the limits. The levels come from the catalog row:
 * the `supportedThinkingLevels` of a family, the one suffix of a single id
 * (`gpt-oss-120b-medium`), or none. With no levels the host shows no effort
 * picker, and `default` keeps the core neutral value.
 */
export function withEffort(
  caps: Capabilities,
  levels: ReadonlyArray<string>,
  defaultLevel: string | undefined,
): Capabilities {
  const fallback = defaultCapabilities().effort.default
  return {
    ...caps,
    effort: { levels: [...levels], default: defaultLevel ?? levels[0] ?? fallback },
  }
}

/** Gemini 4 family (Neon, Carbon, Hydrogen, Argon): 1M context, 262144 out. */
export const CAPS_GEMINI_4: Capabilities = family({
  contextWindow: 1_048_576,
  maxOutputTokens: 262_144,
  vision: true,
  effort: EFFORT_LMHX,
})

/** Gemini 4 Argon and the orchestrators: 65536 output tokens. */
export const CAPS_GEMINI_4_SMALL_OUT: Capabilities = family({
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
  vision: true,
})

/** Gemini 3.8 Flash and Gemini 3 Flash: 65536 output tokens. */
export const CAPS_GEMINI_3_FLASH: Capabilities = family({
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
  vision: true,
})

/** Gemini 3.5 Flash Lite and its aliases: 65535 output tokens. */
export const CAPS_GEMINI_FLASH_LITE: Capabilities = family({
  contextWindow: 1_048_576,
  maxOutputTokens: 65_535,
  vision: true,
  effort: { levels: ["low"] as const, default: "low" },
})

/** Claude on Vertex through this backend: 1M context, 128000 out. */
export const CAPS_CLAUDE_VERTEX: Capabilities = family({
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  vision: true,
})

/**
 * GPT-OSS 120B: 131072 context, 32768 out, no images.
 *
 * It has a numeric reasoning budget, not effort tiers. `medium` is the one
 * honest level: the encoder maps it to a fixed budget. A wider list would
 * promise tiers the backend cannot honor.
 */
export const CAPS_GPT_OSS: Capabilities = family({
  contextWindow: 131_072,
  maxOutputTokens: 32_768,
  thinking: true,
  effort: { levels: ["medium"] as const, default: "medium" },
})

/** Gemini 3.1 Flash Image: image output, 65536 in and out. */
export const CAPS_IMAGE_GEN: Capabilities = family({
  contextWindow: 65_536,
  maxOutputTokens: 65_536,
  thinking: false,
  imageOutput: true,
})

/** The tab_* XML-tool preview models: small limits, no thinking. */
export const CAPS_TAB: Capabilities = family({
  contextWindow: 16_384,
  maxOutputTokens: 4_096,
  thinking: false,
})
