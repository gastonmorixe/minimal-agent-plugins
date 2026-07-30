/**
 * Capability tables per Grok / xAI model + surface.
 *
 * Sources (2026-07-30):
 * - OAuth `GET https://cli-chat-proxy.grok.com/v1/models` (subscription):
 *   grok-4.5 only — context_window 500000, api_backend responses, efforts
 *   high|medium|low (default high), auto_compact_threshold_percent 80
 * - docs.x.ai model pages + pricing (API catalog retained beyond OAuth):
 *   grok-4.5 500k; grok-4.3 / grok-4.20-* 1M; grok-build-0.1 256k;
 *   text+image modalities; tools + structured outputs
 * - https://docs.x.ai/developers/model-capabilities/text/reasoning
 *   (`stop` / presencePenalty / frequencyPenalty error on reasoning models;
 *   grok-4.5 effort low|medium|high default high; multi-agent effort =
 *   agent count including xhigh)
 *
 * Image modality is ON for catalog models so host attachments
 * (`[Image #N]`, screenshots) pass {@link validateOpenAIRequest}.
 *
 * @module llm/providers/grok/capabilities
 */

import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"

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
  strictSchema: true,
} as const

/** Vision / screenshots / pasted images. */
const MODALITIES_TEXT_IMAGE = {
  image: true,
  audio: false,
  pdf: false,
  video: false,
} as const

/** Reasoning models reject stop / presence / frequency penalties (xAI docs). */
const REASONING_SAMPLING = {
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
} as const

// ---------------------------------------------------------------------------
// Shared frontier base (grok-4.5 family)
// ---------------------------------------------------------------------------

const CAPS_GROK_45_BASE: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 500_000,
  maxOutputTokens: 65_536,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  effort: { levels: ["low", "medium", "high"], default: "high" },
  ...REASONING_SAMPLING,
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

/**
 * grok-4.5 on Chat Completions.
 * Accepts reasoning_effort; thinking text may stream as reasoning_content
 * (not always mapped) — visible thinking is weaker on chat than responses.
 */
export const CAPS_GROK_45_CHAT: Capabilities = {
  ...CAPS_GROK_45_BASE,
  thinking: {
    adaptive: true,
    extended: false,
    visible: false,
    interleaved: false,
  },
}

/**
 * grok-4.5 on Responses (preferred for frontier — matches cli-chat-proxy).
 * Visible reasoning summaries + interleaved tool/think patterns.
 */
export const CAPS_GROK_45_RESPONSES: Capabilities = {
  ...CAPS_GROK_45_BASE,
  thinking: {
    adaptive: true,
    extended: false,
    visible: true,
    interleaved: true,
  },
  serverSideHistory: false,
}

/** @deprecated use CAPS_GROK_45_CHAT or CAPS_GROK_45_RESPONSES */
export const CAPS_GROK_45 = CAPS_GROK_45_RESPONSES

// ---------------------------------------------------------------------------
// grok-build-0.1 (256k) — live api.x.ai id; aliases grok-code-fast-*
// ---------------------------------------------------------------------------

export const CAPS_GROK_BUILD_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 256_000,
  maxOutputTokens: 65_536,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: {
    adaptive: true,
    extended: false,
    visible: false,
    interleaved: false,
  },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  ...REASONING_SAMPLING,
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

export const CAPS_GROK_BUILD_RESPONSES: Capabilities = {
  ...CAPS_GROK_BUILD_CHAT,
  thinking: {
    adaptive: true,
    extended: false,
    visible: true,
    interleaved: true,
  },
}

/** @deprecated Prefer {@link CAPS_GROK_BUILD_RESPONSES}; alias kept for older imports. */
export const CAPS_GROK_BUILD = CAPS_GROK_BUILD_RESPONSES

// ---------------------------------------------------------------------------
// grok-4.3 / grok-4.20 family — 1M ctx (live api.x.ai)
// ---------------------------------------------------------------------------

const CAPS_GROK_43_BASE: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  effort: { levels: ["low", "medium", "high"], default: "high" },
  ...REASONING_SAMPLING,
  speedFast: true,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: false,
  serverTools: [],
}

export const CAPS_GROK_43_RESPONSES: Capabilities = {
  ...CAPS_GROK_43_BASE,
  thinking: {
    adaptive: true,
    extended: false,
    visible: true,
    interleaved: true,
  },
}

export const CAPS_GROK_43_CHAT: Capabilities = {
  ...CAPS_GROK_43_BASE,
  thinking: {
    adaptive: true,
    extended: false,
    visible: false,
    interleaved: false,
  },
}

/** Multi-agent: effort controls agent count (low/medium/high/xhigh). */
export const CAPS_GROK_420_MULTI_AGENT: Capabilities = {
  ...CAPS_GROK_43_RESPONSES,
  effort: { levels: ["low", "medium", "high", "xhigh"], default: "high" },
}

/** Non-reasoning 4.20 variant — no effort knob. */
export const CAPS_GROK_420_NON_REASONING: Capabilities = {
  ...CAPS_GROK_43_CHAT,
  thinking: {
    adaptive: false,
    extended: false,
    visible: false,
    interleaved: false,
  },
  effort: { levels: [], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsStopSequences: true,
}

/** Ad-hoc models: vision + tools so images/tools are not rejected. */
export const CAPS_GROK_GENERIC: Capabilities = {
  ...CAPS_GROK_45_CHAT,
  contextWindow: 256_000,
  maxOutputTokens: 32_768,
}
