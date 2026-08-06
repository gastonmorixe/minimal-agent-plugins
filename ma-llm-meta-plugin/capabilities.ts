/**
 * Capability tables for Meta Muse Spark models.
 *
 * Live-verified 2026-08-05 against `api.meta.ai`:
 * - `reasoning_effort` accepts `minimal|low|medium|high|xhigh` for muse-spark-*
 *   (`none` is in the server enum but rejected for these models)
 * - OpenAI Chat Completions + Responses both work
 * - `max_tokens` and `max_completion_tokens` both accepted
 * - Automatic prompt cache accounting via `cached_tokens` (subset)
 * - All Muse Spark SKUs are multimodal: image + video + PDF/document + text
 *   (platform Capabilities tiles: Image/Video/File handling). 1.1 was
 *   documented as multimodal at launch; 1.2 / 1.2-contributor share the
 *   same platform surface. See `private/MA-49282-meta-provider/`
 *   (wayback-ai-docs.txt, promptfoo-meta-model.txt, byteiota + layer3).
 * - Server tools: web_search grounding ($2.50/1k), computer_use, file_search
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

const MODALITIES_MULTIMODAL = {
  image: true,
  audio: false,
  pdf: true,
  video: true,
} as const

const SERVER_TOOLS_MUSE = ["web_search", "computer_use", "file_search"] as const

/** Wire values Meta accepts on muse-spark (none is rejected). */
const EFFORT_MUSE = {
  levels: ["minimal", "low", "medium", "high", "xhigh"] as const,
  default: "medium" as const,
}

const CONTEXT_1M = 1_048_576
/** Commonly cited max output; dashboard does not list a lower hard cap. */
const MAX_OUT = 131_072

function baseMuse(opts: { vision?: boolean }): Capabilities {
  return {
    ...defaultCapabilities(),
    contextWindow: CONTEXT_1M,
    maxOutputTokens: MAX_OUT,
    maxOutputTokensBatch: null,
    thinking: { adaptive: true, extended: false, visible: false, interleaved: false },
    effort: { ...EFFORT_MUSE },
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

/** Muse Spark 1.2 — coding / agentic flagship (multimodal). */
export const CAPS_MUSE_SPARK_1_2: Capabilities = baseMuse({ vision: true })

/** Muse Spark 1.1 — multimodal / computer-use oriented. */
export const CAPS_MUSE_SPARK_1_1: Capabilities = baseMuse({ vision: true })

/** Contributor SKU — same surface, cheaper, trains on data (multimodal). */
export const CAPS_MUSE_SPARK_1_2_CONTRIBUTOR: Capabilities = baseMuse({ vision: true })
