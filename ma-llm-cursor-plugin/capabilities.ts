import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"
import type { DecodedCursorModel } from "./proto/models-decode.ts"

export interface CursorCapsOptions {
  contextWindow?: number
  maxOutputTokens?: number
  thinking?: boolean
  vision?: boolean
  effortLevels?: ReadonlyArray<string>
  maxMode?: boolean
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_OUTPUT_TOKENS = 16_384
const DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const

/** Capabilities for the `cursor-agent-run` surface. MA owns tools; Cursor supplies text/thinking. */
export function cursorCaps(options: CursorCapsOptions = {}): Capabilities {
  const thinking = options.thinking ?? false
  const effortLevels = options.effortLevels ?? (thinking ? DEFAULT_EFFORT_LEVELS : [])
  const base = defaultCapabilities()
  return {
    ...base,
    contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
    outputTokensShareContextWindow: true,
    thinking: {
      adaptive: thinking,
      extended: false,
      visible: thinking,
      interleaved: false,
    },
    effort: {
      levels: [...effortLevels],
      default: effortLevels.includes("medium") ? "medium" : (effortLevels[0] ?? "medium"),
    },
    acceptsTemperature: false,
    acceptsTopP: false,
    acceptsTopK: false,
    acceptsSeed: false,
    acceptsStopSequences: false,
    speedFast: false,
    tools: {
      userDefined: true,
      parallel: true,
      fineGrainedStreaming: false,
      toolChoice: false,
      strictSchema: false,
    },
    midConversationSystem: true,
    structuredOutputs: false,
    assistantPrefill: false,
    modalities: {
      image: options.vision ?? false,
      audio: false,
      pdf: false,
      video: false,
    },
    serverSideHistory: false,
    serverTools: [],
  }
}

/** Map AvailableModels capability flags into minimal-agent's provider-neutral table. */
export function deriveCursorCapabilities(model: DecodedCursorModel): Capabilities {
  const effortLevels = model.cloudAgentEffortModes?.length
    ? model.cloudAgentEffortModes.map(String)
    : model.supportsThinking
      ? [...DEFAULT_EFFORT_LEVELS]
      : []
  return cursorCaps({
    contextWindow:
      model.contextTokenLimitForMaxMode ?? model.contextTokenLimit ?? DEFAULT_CONTEXT_WINDOW,
    thinking: model.supportsThinking,
    vision: model.supportsImages,
    effortLevels,
    maxMode: model.supportsMaxMode,
  })
}

/** Alias used by adapter/model code that wants the provider's generic baseline. */
export const cursorCapabilities = cursorCaps
