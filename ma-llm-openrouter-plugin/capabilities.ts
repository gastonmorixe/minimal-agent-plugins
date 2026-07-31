/**
 * Capability tables for OpenRouter models (OpenAI-Chat-compatible gateway).
 *
 * OpenRouter normalizes every upstream model to the OpenAI Chat Completions
 * wire format, so this plugin reuses `llm-openai`'s wire layer (see
 * `adapter.ts`). Curated slugs each get their own `Capabilities` record
 * derived from live GET https://openrouter.ai/api/v1/models fields
 * (context_length, top_provider.max_completion_tokens,
 * architecture.input_modalities, supported_parameters) as of 2026-07-30.
 * Ad-hoc / unknown slugs fall back to {@link CAPS_OPENROUTER_CHAT}.
 *
 * Convention: OpenRouter `file` input modality → `modalities.pdf` (documents),
 * matching `lib/modality-check.ts`.
 *
 * @module llm/providers/openrouter/capabilities
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

const TOOLS_NONE = {
  userDefined: false,
  parallel: false,
  fineGrainedStreaming: false,
  toolChoice: false,
  strictSchema: false,
} as const

/** Text-only. */
const M_TEXT = { image: false, audio: false, pdf: false, video: false } as const

/** Text + image. */
const M_TI = { image: true, audio: false, pdf: false, video: false } as const

/** Text + image + file (documents → pdf). */
const M_TIP = { image: true, audio: false, pdf: true, video: false } as const

/**
 * Fallback max output when OpenRouter omits
 * `top_provider.max_completion_tokens` (null). Matches the prior shared
 * gateway default — not an invented per-model figure.
 */
const MAX_OUT_WHEN_OMITTED = 128_000

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
    serverSideHistory: false,
    serverTools: [],
  }
}

// ---------------------------------------------------------------------------
// Gateway default (ad-hoc slugs)
// ---------------------------------------------------------------------------

/**
 * Permissive OpenRouter chat capability for ad-hoc / unlisted slugs.
 * Snapshot baseline as of 2026-07-30 (~1M context / 128k max out common
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
// Curated per-model capabilities (live OpenRouter 2026-07-30)
// ---------------------------------------------------------------------------

/**
 * moonshotai/kimi-k3 — ctx 1_048_576; max_completion_tokens omitted;
 * input text+image; tools + structured + reasoning (+ include_reasoning);
 * temperature/top_p/top_k/seed/stop.
 */
export const CAPS_OR_KIMI_K3: Capabilities = {
  ...orChatBase(1_048_576, MAX_OUT_WHEN_OMITTED, M_TI, {
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
 * deepseek/deepseek-v4-flash — ctx 1_048_576; max out 393_216; text-only;
 * tools + structured + reasoning (+ include_reasoning);
 * temperature/top_p/top_k/seed/stop.
 */
export const CAPS_OR_DEEPSEEK_V4_FLASH: Capabilities = {
  ...orChatBase(1_048_576, 393_216, M_TEXT, {
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
 * anthropic/claude-sonnet-5 — ctx 1_000_000; max out 128_000;
 * text+image+file; tools + structured + reasoning (+ include_reasoning);
 * stop only (no temperature/top_p/seed/top_k on the live row).
 */
export const CAPS_OR_CLAUDE_SONNET_5: Capabilities = {
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
 * anthropic/claude-opus-5 — ctx 1_000_000; max out 128_000;
 * text+image+file; tools + structured + reasoning (+ include_reasoning);
 * temperature + stop (no top_p/seed/top_k on the live row).
 */
export const CAPS_OR_CLAUDE_OPUS_5: Capabilities = {
  ...orChatBase(1_000_000, 128_000, M_TIP, {
    temperature: true,
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
 * openai/gpt-5.6-sol — ctx 1_050_000; max out 128_000; text+image+file;
 * tools + structured + reasoning (+ include_reasoning);
 * seed only among sampling knobs (no temperature/top_p/stop/top_k).
 */
export const CAPS_OR_GPT_56_SOL: Capabilities = {
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
 * x-ai/grok-4.5 — ctx 500_000; max_completion_tokens omitted;
 * text+image+file; tools + structured + reasoning (+ include_reasoning);
 * temperature/top_p/seed/stop (no top_k).
 */
export const CAPS_OR_GROK_45: Capabilities = {
  ...orChatBase(500_000, MAX_OUT_WHEN_OMITTED, M_TIP, {
    temperature: true,
    topP: true,
    topK: false,
    seed: true,
    stop: true,
    tools: true,
    structured: true,
  }),
  ...thinkReasoning(true),
}

/**
 * openai/gpt-4o-mini — ctx 128_000; max out 16_384; text+image+file;
 * tools + structured; no reasoning params on the live row;
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
