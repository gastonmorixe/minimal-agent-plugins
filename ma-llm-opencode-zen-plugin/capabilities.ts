/** Per-family capabilities for the live OpenCode Zen catalog. */
import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"

const CACHE = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 1024,
  reportsCacheHits: true,
  promptCacheAccounting: "subset" as const,
} as const
const TOOLS = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: false,
} as const

export type ZenCapabilityProfile =
  | "claude"
  | "gemini"
  | "gpt"
  | "grok"
  | "muse"
  | "chat"
  | "messages"
  | "free"

const MODALITIES = {
  text: { image: false, audio: false, pdf: false, video: false },
  vision: { image: true, audio: false, pdf: false, video: false },
  all: { image: true, audio: true, pdf: true, video: true },
} as const

function make(
  profile: ZenCapabilityProfile,
  contextWindow: number,
  maxOutputTokens: number,
): Capabilities {
  const responses = profile === "gpt" || profile === "grok" || profile === "muse"
  const messages = profile === "claude" || profile === "messages"
  const gemini = profile === "gemini"
  const free = profile === "free"
  const reasoningLevels = messages
    ? ["none", "low", "medium", "high"]
    : responses
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "max"]
  return {
    ...defaultCapabilities(),
    contextWindow,
    maxOutputTokens,
    maxOutputTokensBatch: null,
    thinking: {
      adaptive: messages || responses,
      extended: !messages,
      visible: true,
      interleaved: responses || messages,
    },
    effort: { levels: reasoningLevels, default: "medium" },
    acceptsTemperature: !responses && !gemini,
    acceptsTopP: !responses && !gemini,
    acceptsTopK: false,
    acceptsSeed: !messages && !responses,
    acceptsStopSequences: !responses,
    speedFast: false,
    caching: { ...CACHE },
    tools: { ...TOOLS },
    midConversationSystem: true,
    structuredOutputs: true,
    assistantPrefill: false,
    modalities: {
      ...(profile === "claude" || profile === "gemini" || profile === "grok"
        ? MODALITIES.vision
        : profile === "muse" || free
          ? MODALITIES.all
          : MODALITIES.text),
    },
    serverSideHistory: false,
    serverTools: [],
  }
}

/** Capability profiles sourced from the Zen docs and models.dev family limits. */
export const CAPS_CLAUDE = make("claude", 1_000_000, 128_000)
export const CAPS_GEMINI = make("gemini", 1_000_000, 65_536)
export const CAPS_GPT = make("gpt", 1_050_000, 128_000)
export const CAPS_GROK = make("grok", 500_000, 128_000)
export const CAPS_MUSE = make("muse", 1_048_576, 131_072)
export const CAPS_CHAT = make("chat", 1_000_000, 131_072)
export const CAPS_MESSAGES = make("messages", 1_000_000, 131_072)
export const CAPS_FREE = make("free", 1_000_000, 131_072)

export const CAPS_OX_ALPHA_FREE = CAPS_FREE
export const CAPS_OPENCODE_ZEN_CHAT_FALLBACK = CAPS_CHAT
