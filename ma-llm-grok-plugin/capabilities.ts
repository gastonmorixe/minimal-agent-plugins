/**
 * Capability tables per Grok / xAI model + surface.
 *
 * Sources:
 * - Live `GET /v1/models` (context_window, reasoning_efforts, api_backend)
 * - Grok Build harness (image attachments, tools, reasoning streaming)
 * - OpenAI dual-surface pattern (chat vs responses thinking visibility)
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
  // Responses can chain via previous_response_id when store=true; default store
  // false on many paths, so keep serverSideHistory false until we opt in.
  serverSideHistory: false,
}

/** @deprecated use CAPS_GROK_45_CHAT or CAPS_GROK_45_RESPONSES */
export const CAPS_GROK_45 = CAPS_GROK_45_RESPONSES

// ---------------------------------------------------------------------------
// grok-build
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

/** @deprecated */
export const CAPS_GROK_BUILD = CAPS_GROK_BUILD_RESPONSES

// ---------------------------------------------------------------------------
// composer fast
// ---------------------------------------------------------------------------

export const CAPS_GROK_COMPOSER_25_FAST: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  outputTokensShareContextWindow: true,
  maxOutputTokensBatch: null,
  thinking: {
    adaptive: false,
    extended: false,
    visible: false,
    interleaved: false,
  },
  effort: { levels: [], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: false,
  serverTools: [],
}

/** Ad-hoc models: vision + tools so images/tools are not rejected. */
export const CAPS_GROK_GENERIC: Capabilities = {
  ...CAPS_GROK_45_CHAT,
  contextWindow: 256_000,
  maxOutputTokens: 32_768,
}
