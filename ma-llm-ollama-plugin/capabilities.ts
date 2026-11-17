/**
 * Capability tables for Ollama Cloud models.
 *
 * Ollama Cloud serves frontier open-weight models over its native
 * `/api/chat` protocol (see `adapter.ts`). Each model family advertises a
 * different mix of capabilities on Ollama's model library
 * (https://ollama.com/search?c=cloud): thinking, tools, vision, audio, and a
 * per-model context window. This module encodes those as data so the agent
 * loop gates requests on capability flags, never on a model-id branch.
 *
 * Cloud models all stream, all accept tools (the ones we register), and most
 * "think". Vision/audio vary per family and are reflected in `modalities`.
 *
 * @module llm/providers/ollama/capabilities
 */

import {
  type Capabilities,
  defaultCapabilities,
} from "@minimal-agent/core/plugin-api/llm/capabilities"

/**
 * Shared base for an Ollama Cloud chat model: streaming text, tool calling,
 * sampling knobs Ollama's `options` block accepts (temperature, top_p, top_k,
 * seed, stop). No prompt caching is reported by the native protocol. Per-model
 * factories below overlay context window, thinking, effort, and modalities.
 */
function baseOllamaCaps(): Capabilities {
  return {
    ...defaultCapabilities(),
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    outputTokensShareContextWindow: true,
    maxOutputTokensBatch: null,
    thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
    effort: { levels: [], default: "medium" },
    // Ollama exposes these through the request `options` object.
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: true,
    acceptsSeed: true,
    acceptsStopSequences: true,
    speedFast: false,
    caching: {
      explicit: false,
      automatic: false,
      ttls: [],
      minPrefixTokens: 0,
      reportsCacheHits: false,
    },
    tools: {
      userDefined: true,
      parallel: true,
      // Ollama streams whole tool_calls per chunk (arguments arrive as a
      // parsed object), not fine-grained partial-JSON deltas.
      fineGrainedStreaming: false,
      toolChoice: false,
      strictSchema: false,
    },
    // The native chat protocol accepts role:"system" messages anywhere.
    midConversationSystem: true,
    // `format` accepts a JSON schema object for structured output.
    structuredOutputs: true,
    assistantPrefill: false,
    modalities: { image: false, audio: false, pdf: false, video: false },
    serverSideHistory: false,
    serverTools: [],
  }
}

/** Options that vary per Ollama Cloud model family. */
export interface OllamaCapsOptions {
  contextWindow: number
  /** Output-token ceiling (`num_predict`). Defaults to a conservative 8K. */
  maxOutputTokens?: number
  /** Whether the model supports a "thinking" / reasoning trace. */
  thinking?: boolean
  /**
   * When the model accepts discrete reasoning levels (Ollama `think` as a
   * string, e.g. gpt-oss low/medium/high, or DeepSeek V4's High/Max modes), the
   * accepted set in ascending order. Implies `thinking: true`. Ollama accepts
   * either a boolean or one of these level strings on the `think` field.
   */
  effortLevels?: ReadonlyArray<"low" | "medium" | "high" | "xhigh" | "max">
  /** Image input (vision). */
  vision?: boolean
  /**
   * Audio input on the model card. The native `/api/chat` has no audio slot
   * (audio goes only to `/v1/audio/transcriptions`), so the flag stays off
   * and an audio block is rejected up front.
   */
  audio?: boolean
}

/**
 * Image formats the native `/api/chat` `images[]` array takes (base64 only;
 * the REST API does not take a URL). Source:
 * https://docs.ollama.com/capabilities/vision (2026-11-17).
 */
export const OLLAMA_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/**
 * Build a capability record for one Ollama Cloud model family from its
 * advertised feature set. Thinking models stream their reasoning trace
 * (`message.thinking` deltas), so `visible` is set whenever `thinking` is on.
 */
export function ollamaCaps(opts: OllamaCapsOptions): Capabilities {
  const caps = baseOllamaCaps()
  caps.contextWindow = opts.contextWindow
  if (opts.maxOutputTokens !== undefined) caps.maxOutputTokens = opts.maxOutputTokens
  const hasEffort = opts.effortLevels !== undefined && opts.effortLevels.length > 0
  const thinks = Boolean(opts.thinking) || hasEffort
  caps.thinking = {
    adaptive: thinks,
    extended: false,
    // Ollama streams the model's thinking trace as `message.thinking` text.
    visible: thinks,
    interleaved: false,
  }
  if (hasEffort) {
    const levels = [...(opts.effortLevels ?? [])]
    // Default to "medium" when offered, else the lowest declared level.
    const dft = levels.includes("medium") ? "medium" : (levels[0] ?? "medium")
    caps.effort = { levels, default: dft }
  }
  // Native `/api/chat` takes base64 images only: no audio, PDF or video.
  caps.modalities = {
    image: Boolean(opts.vision),
    audio: false,
    pdf: false,
    video: false,
  }
  caps.inputMimeTypes = opts.vision ? OLLAMA_IMAGE_MIME_TYPES : []
  return caps
}
