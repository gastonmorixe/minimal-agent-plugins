/** Capabilities for OpenCode Zen models. */
import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"

const MODALITIES_OX = { image: true, audio: false, pdf: false, video: true } as const
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

/** Ox Alpha Free: 1M context, 131K output, text/image/video, free. */
export const CAPS_OX_ALPHA_FREE: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 131_072,
  maxOutputTokensBatch: null,
  thinking: { adaptive: false, extended: true, visible: true, interleaved: false },
  effort: { levels: ["low", "high", "max"], default: "high" },
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
  modalities: { ...MODALITIES_OX },
  serverSideHistory: false,
  serverTools: [],
}

export const CAPS_OPENCODE_ZEN_CHAT_FALLBACK: Capabilities = CAPS_OX_ALPHA_FREE
