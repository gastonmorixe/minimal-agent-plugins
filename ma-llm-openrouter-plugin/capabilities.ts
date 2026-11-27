/**
 * Capability tables for OpenRouter models (OpenAI-Chat-compatible gateway).
 *
 * OpenRouter normalizes every upstream model to the OpenAI Chat Completions
 * wire format, so this plugin reuses `llm-openai`'s wire layer (see
 * `adapter.ts`). Curated slugs each get their own `Capabilities` record
 * derived from live GET https://openrouter.ai/api/v1/models fields
 * (context_length, top_provider.max_completion_tokens,
 * architecture.input_modalities, supported_parameters) as of 2026-11-18.
 * Ad-hoc / unknown slugs fall back to {@link CAPS_OPENROUTER_CHAT}.
 *
 * Convention: OpenRouter `file` input modality → `modalities.pdf` (documents),
 * matching `lib/modality-check.ts`. OpenRouter parses a PDF `file` part on
 * every model (native, or its `mistral-ocr` / `cloudflare-ai` engine), so
 * every model sets `pdf`. Each record carries its `inputMimeTypes` (see
 * {@link openRouterInputMimeTypes}).
 *
 * @module llm/providers/openrouter/capabilities
 */

import {
  type Capabilities,
  defaultCapabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"

// ---------------------------------------------------------------------------
// Input formats (https://openrouter.ai/docs/guides/overview/multimodal/,
// checked 2026-11-17)
// ---------------------------------------------------------------------------

/** Image formats (`image_url`, url or base64). */
export const OPENROUTER_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]

/** Document formats (`file` part, url or base64): PDF on every model. */
export const OPENROUTER_DOCUMENT_MIME_TYPES: readonly string[] = ["application/pdf"]

/** Audio formats (`input_audio`, base64 only): wav and mp3. */
export const OPENROUTER_AUDIO_MIME_TYPES: readonly string[] = ["audio/wav", "audio/mpeg"]

/** Video formats (`video_url`, url or data URL): mp4, mpeg, mov and webm. */
export const OPENROUTER_VIDEO_MIME_TYPES: readonly string[] = [
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
]

/** Every format OpenRouter can take, before the per-model modality filter. */
export const OPENROUTER_DEFAULT_MIME_TYPES: readonly string[] = [
  ...OPENROUTER_IMAGE_MIME_TYPES,
  ...OPENROUTER_DOCUMENT_MIME_TYPES,
  ...OPENROUTER_AUDIO_MIME_TYPES,
  ...OPENROUTER_VIDEO_MIME_TYPES,
]

/**
 * The input MIME types of an OpenRouter model: its `inputMimeTypes`, else the
 * OpenRouter set filtered by the modality flags (audio only on a model with
 * audio input, video only on a model with video input).
 */
export function openRouterInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, OPENROUTER_DEFAULT_MIME_TYPES)
}

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

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

const TOOLS_NONE = {
  userDefined: false,
  parallel: false,
  fineGrainedStreaming: false,
  toolChoice: false,
  strictSchema: false,
} as const

/**
 * Text + image (+ PDF: OpenRouter parses a PDF `file` part on any model, so
 * the live `file` modality is not needed for it).
 */
const M_TI = { image: true, audio: false, pdf: true, video: false } as const

/** Text + image + video (+ PDF, as above). */
const M_TIV = { image: true, audio: false, pdf: true, video: true } as const

/** Text + image + file (documents → pdf). */
const M_TIP = { image: true, audio: false, pdf: true, video: false } as const

/** Text only (+ PDF: OpenRouter parses a PDF `file` part on any model). */
const M_T = { image: false, audio: false, pdf: true, video: false } as const

/**
 * Common OpenRouter `reasoning_effort` values when the live row lists the
 * parameter but not the enum. Upstream may accept a wider set.
 */
const OR_EFFORT = ["low", "medium", "high"] as const

function thinkReasoning(visible: boolean) {
  return {
    thinking: {
      adaptive: true,
      extended: false,
      visible,
      interleaved: false,
    } as const,
    effort: { levels: [...OR_EFFORT], default: "medium" as const },
  }
}

const THINK_OFF = {
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false } as const,
  effort: { levels: [] as const, default: "medium" as const },
}

function orChatBase(
  ctx: number,
  maxOut: number,
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean },
  opts: {
    temperature: boolean
    topP: boolean
    topK: boolean
    seed: boolean
    stop: boolean
    tools: boolean
    structured: boolean
  },
): Capabilities {
  return {
    ...defaultCapabilities(),
    contextWindow: ctx,
    maxOutputTokens: maxOut,
    maxOutputTokensBatch: null,
    acceptsTemperature: opts.temperature,
    acceptsTopP: opts.topP,
    acceptsTopK: opts.topK,
    acceptsSeed: opts.seed,
    acceptsStopSequences: opts.stop,
    speedFast: false,
    caching: { ...CACHING_AUTO },
    tools: opts.tools ? { ...TOOLS_FULL } : { ...TOOLS_NONE },
    midConversationSystem: true,
    structuredOutputs: opts.structured,
    assistantPrefill: false,
    modalities: { ...modalities },
    inputMimeTypes: openRouterInputMimeTypes({ modalities }),
    serverSideHistory: false,
    serverTools: [],
  }
}

// ---------------------------------------------------------------------------
// Gateway default (ad-hoc slugs)
// ---------------------------------------------------------------------------

/**
 * Permissive OpenRouter chat capability for ad-hoc / unlisted slugs.
 * Snapshot baseline as of 2026-11-15 (~1M context / 128k max out common
 * among frontier rows). Prefer a per-model CAPS_* when the slug is curated.
 */
export const CAPS_OPENROUTER_CHAT: Capabilities = {
  ...orChatBase(1_000_000, 128_000, M_TI, {
    temperature: true,
    topP: true,
    topK: false,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...THINK_OFF,
}

// ---------------------------------------------------------------------------
// Curated per-model capabilities (live OpenRouter 2026-11-15)
// ---------------------------------------------------------------------------

/**
 * moonshotai/kimi-k3.1-pro: ctx 1_048_576, max out 943_718,
 * input text+image+video, tools + structured + reasoning (+ include_reasoning),
 * temperature/top_p/top_k/seed/stop.
 */
export const CAPS_OR_KIMI_K31_PRO: Capabilities = {
  ...orChatBase(1_048_576, 943_718, M_TIV, {
    temperature: true,
    topP: true,
    topK: true,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * deepseek/deepseek-v4.1-flash: ctx 1_048_576, max out 393_216, text+image,
 * tools + structured + reasoning (+ include_reasoning),
 * temperature/top_p/top_k/seed/stop.
 */
export const CAPS_OR_DEEPSEEK_V41_FLASH: Capabilities = {
  ...orChatBase(1_048_576, 393_216, M_TI, {
    temperature: true,
    topP: true,
    topK: true,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
  speedFast: true,
}

/**
 * anthropic/claude-sonnet-5.5: ctx 1_000_000, max out 128_000,
 * text+image+file, tools + structured + reasoning (+ include_reasoning),
 * stop only (no temperature/top_p/seed/top_k on the live row).
 */
export const CAPS_OR_CLAUDE_SONNET_55: Capabilities = {
  ...orChatBase(1_000_000, 128_000, M_TIP, {
    temperature: false,
    topP: false,
    topK: false,
    seed: false,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * anthropic/claude-opus-5.5: ctx 1_000_000, max out 128_000,
 * text+image+file, tools + structured + reasoning (+ include_reasoning),
 * stop only (no temperature/top_p/seed/top_k on the live row).
 */
export const CAPS_OR_CLAUDE_OPUS_55: Capabilities = {
  ...orChatBase(1_000_000, 128_000, M_TIP, {
    temperature: false,
    topP: false,
    topK: false,
    seed: false,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * openai/gpt-6.1-sol: ctx 1_050_000, max out 128_000, text+image+file,
 * tools + structured + reasoning (+ include_reasoning),
 * seed only among sampling knobs (no temperature/top_p/stop/top_k).
 */
export const CAPS_OR_GPT_61_SOL: Capabilities = {
  ...orChatBase(1_050_000, 128_000, M_TIP, {
    temperature: false,
    topP: false,
    topK: false,
    seed: true,
    stop: false,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * openai/gpt-6.2-sol: ctx 1_050_000, max out 128_000, text+image+file,
 * tools + structured + reasoning (+ include_reasoning),
 * seed only among sampling knobs (no temperature/top_p/stop/top_k).
 * Live 2026-11-18 (created 2026-11-17, canonical_slug
 * openai/gpt-6.2-sol-20261117); same wire shape as the 6.1-sol row.
 * Base tier: prompts over 272K tokens bill 4/15 (cache 5/0.2) per the live
 * `overrides` row (unchanged from 6.1-sol).
 */
export const CAPS_OR_GPT_62_SOL: Capabilities = {
  ...orChatBase(1_050_000, 128_000, M_TIP, {
    temperature: false,
    topP: false,
    topK: false,
    seed: true,
    stop: false,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * x-ai/grok-4.7: ctx 500_000, max out 450_000, text+image+file,
 * tools + structured + reasoning (+ include_reasoning),
 * temperature/top_p/top_k/seed/stop.
 */
export const CAPS_OR_GROK_47: Capabilities = {
  ...orChatBase(500_000, 450_000, M_TIP, {
    temperature: true,
    topP: true,
    topK: true,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * inclusionai/ling-3.0-tiny (live 2026-11-27, created 2026-08-06): ctx
 * 262_144, max out 250_000, text input only, tools + structured outputs,
 * temperature/top_p/seed/stop (no top_k in `supported_parameters`). The row
 * lists `reasoning` but not `reasoning_effort` and has no `supported_efforts`
 * (`reasoning.default_enabled: true`), so the adapter has no effort to send:
 * THINK_OFF, and the model reasons at its default.
 */
export const CAPS_OR_LING_30_TINY: Capabilities = {
  ...orChatBase(262_144, 250_000, M_T, {
    temperature: true,
    topP: true,
    topK: false,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...THINK_OFF,
}

/**
 * openai/gpt-4o-mini: ctx 128_000, max out 16_384, text+image+file,
 * tools + structured, no reasoning params on the live row,
 * temperature/top_p/seed/stop.
 */
export const CAPS_OR_GPT_4O_MINI: Capabilities = {
  ...orChatBase(128_000, 16_384, M_TIP, {
    temperature: true,
    topP: true,
    topK: false,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...THINK_OFF,
}
