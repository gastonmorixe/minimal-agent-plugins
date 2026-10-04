/**
 * Capability tables for Meta Muse Spark models (Chat + Responses).
 *
 * Live-verified against `api.meta.ai`:
 * - 2026-08-05: chat + responses, effort matrix, rate-limit headers
 * - 2026-10-04: GET /v1/models includes muse-spark-1.3 (+ contributor);
 *   Responses store:false + include reasoning.encrypted_content → 200
 *
 * Docs (Jonathan meta-harness, 2026-10-04):
 * - Standard 1.3 effort: minimal|low|medium|high|xhigh|max (`none` → 400)
 * - Contributor: same except `max` unavailable
 * - Modalities: text/image/video/PDF; audio understanding exists but degraded on 1.3
 * - GET /v1/models is id-only (no pricing/context on wire)
 *
 * Context mode (Responses): `serverSideHistory: false` by default. Stateless
 * encrypted CoT replay is the adapter default.
 *
 * @module llm/providers/meta/capabilities
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

const MODALITIES_TEXT = {
  image: false,
  audio: false,
  pdf: false,
  video: false,
} as const

/**
 * Muse Spark multimodal. Docs list audio input, but 1.3 audio understanding is
 * currently degraded (prefer muse-voice-transcribe / 1.2 for ASR). Keep audio
 * false so the agent does not send audio parts by default.
 */
const MODALITIES_MULTIMODAL = {
  image: true,
  audio: false,
  pdf: true,
  video: true,
} as const

const SERVER_TOOLS_MUSE = ["web_search", "computer_use", "file_search"] as const

/** Muse Spark without Standard-only `max` (1.1 / 1.2 / Contributor). */
const EFFORT_MUSE = {
  levels: ["minimal", "low", "medium", "high", "xhigh"] as const,
  default: "medium" as const,
}

/** Standard muse-spark-1.3 only: docs add `max` beyond xhigh. */
const EFFORT_MUSE_1_3_STANDARD = {
  levels: ["minimal", "low", "medium", "high", "xhigh", "max"] as const,
  default: "medium" as const,
}

const CONTEXT_1M = 1_048_576
/**
 * Request-side output budget. Models page does not publish a fixed max_output
 * cap; 131072 is the common ecosystem cite (promptfoo / prior research).
 */
const MAX_OUT = 131_072

function baseMuse(opts: {
  vision?: boolean
  effort?: { levels: readonly string[]; default: string }
}): Capabilities {
  const effort = opts.effort ?? EFFORT_MUSE
  return {
    ...defaultCapabilities(),
    contextWindow: CONTEXT_1M,
    maxOutputTokens: MAX_OUT,
    maxOutputTokensBatch: null,
    effort: { levels: [...effort.levels], default: effort.default },
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
    modalities: opts.vision ? { ...MODALITIES_MULTIMODAL } : { ...MODALITIES_TEXT },
    serverSideHistory: false,
    serverTools: [...SERVER_TOOLS_MUSE],
  }
}

function chatCaps(opts: {
  vision?: boolean
  effort?: { levels: readonly string[]; default: string }
}): Capabilities {
  return {
    ...baseMuse(opts),
    thinking: { adaptive: true, extended: false, visible: false, interleaved: false },
    serverSideHistory: false,
  }
}

function responsesCaps(opts: {
  vision?: boolean
  effort?: { levels: readonly string[]; default: string }
}): Capabilities {
  return {
    ...baseMuse(opts),
    thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
    serverSideHistory: false,
  }
}

/** Muse Spark 1.3 Chat Completions (Standard; includes effort `max`). */
export const CAPS_MUSE_SPARK_1_3_CHAT: Capabilities = chatCaps({
  vision: true,
  effort: EFFORT_MUSE_1_3_STANDARD,
})

/** Muse Spark 1.3 Responses (current flagship; includes effort `max`). */
export const CAPS_MUSE_SPARK_1_3_RESPONSES: Capabilities = responsesCaps({
  vision: true,
  effort: EFFORT_MUSE_1_3_STANDARD,
})

/** Muse Spark 1.3 Contributor Chat Completions (`max` unavailable). */
export const CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_CHAT: Capabilities = chatCaps({ vision: true })

/** Muse Spark 1.3 Contributor Responses (`max` unavailable). */
export const CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_RESPONSES: Capabilities = responsesCaps({
  vision: true,
})

/** Muse Spark 1.2 Chat Completions. */
export const CAPS_MUSE_SPARK_1_2_CHAT: Capabilities = chatCaps({ vision: true })

/** Muse Spark 1.2 Responses. */
export const CAPS_MUSE_SPARK_1_2_RESPONSES: Capabilities = responsesCaps({ vision: true })

/** Muse Spark 1.1 Chat Completions. */
export const CAPS_MUSE_SPARK_1_1_CHAT: Capabilities = chatCaps({ vision: true })

/** Muse Spark 1.1 Responses. */
export const CAPS_MUSE_SPARK_1_1_RESPONSES: Capabilities = responsesCaps({ vision: true })

/** Muse Spark 1.2 Contributor Chat Completions. */
export const CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_CHAT: Capabilities = chatCaps({ vision: true })

/** Muse Spark 1.2 Contributor Responses. */
export const CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_RESPONSES: Capabilities = responsesCaps({
  vision: true,
})

/** @deprecated use CAPS_MUSE_SPARK_1_3_RESPONSES */
export const CAPS_MUSE_SPARK_1_3 = CAPS_MUSE_SPARK_1_3_RESPONSES

/** @deprecated use CAPS_MUSE_SPARK_1_2_RESPONSES */
export const CAPS_MUSE_SPARK_1_2 = CAPS_MUSE_SPARK_1_2_RESPONSES

/** @deprecated use CAPS_MUSE_SPARK_1_1_RESPONSES */
export const CAPS_MUSE_SPARK_1_1 = CAPS_MUSE_SPARK_1_1_RESPONSES

/** @deprecated use CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_RESPONSES */
export const CAPS_MUSE_SPARK_1_3_CONTRIBUTOR = CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_RESPONSES

/** @deprecated use CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_RESPONSES */
export const CAPS_MUSE_SPARK_1_2_CONTRIBUTOR = CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_RESPONSES
