/**
 * Meta Muse Spark model registry — Responses-primary with Chat companions.
 *
 * Pattern from `ma-llm-grok-plugin/models.ts`:
 * - Bare ids (`muse-spark-1.3`) → `openai-responses`
 * - `-chat` companions → `openai-chat-completions`
 * - `vendorIds.firstParty` is always the bare wire slug Meta expects
 *
 * Live catalog (Jonathan meta-harness + Anthony probe, 2026-10-04
 * `GET /v1/models`): muse-spark-1.3, 1.3-contributor, 1.2, 1.2-contributor,
 * 1.1 (+ non-text ids sam/image/voice not registered here).
 *
 * @module llm/providers/meta/models
 */

import {
  CAPS_MUSE_SPARK_1_1_CHAT,
  CAPS_MUSE_SPARK_1_1_RESPONSES,
  CAPS_MUSE_SPARK_1_2_CHAT,
  CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_CHAT,
  CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_RESPONSES,
  CAPS_MUSE_SPARK_1_2_RESPONSES,
  CAPS_MUSE_SPARK_1_3_CHAT,
  CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_CHAT,
  CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_RESPONSES,
  CAPS_MUSE_SPARK_1_3_RESPONSES,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_META_GENERIC,
  PRICING_MUSE_SPARK_1_1,
  PRICING_MUSE_SPARK_1_2,
  PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
  PRICING_MUSE_SPARK_1_3,
  PRICING_MUSE_SPARK_1_3_CONTRIBUTOR,
} from "./pricing.ts"

const estimateMetaTokens = makeCharRatioEstimator(3.8)

export interface MetaModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  aliases?: string[]
  surfaceId?: "openai-chat-completions" | "openai-responses"
}

interface LocalCatalogEntry {
  tags: readonly string[]
  contextWindow: number
  displayName: string
}
const localCatalog = new Map<string, LocalCatalogEntry>()

/** Default model id for new Meta sessions (Responses surface). */
export const META_DEFAULT_MODEL_ID = "muse-spark-1.3"

const BUILTIN_IDS = [
  "muse-spark-1.3",
  "muse-spark-1.3-chat",
  "muse-spark-1.3-contributor",
  "muse-spark-1.3-contributor-chat",
  "muse-spark-1.2",
  "muse-spark-1.2-chat",
  "muse-spark-1.1",
  "muse-spark-1.1-chat",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2-contributor-chat",
] as const

function reg(
  registrar: ModelRegistrar,
  spec: {
    id: string
    surfaceId: string
    displayName: string
    tags: string[]
    capabilities: Capabilities
    pricing: MTokRate
    wireId: string
    aliases?: string[]
  },
): void {
  const full: ProviderModelSpec = {
    id: spec.id,
    aliases: spec.aliases,
    providerId: "meta",
    surfaceId: spec.surfaceId,
    displayName: spec.displayName,
    tags: spec.tags,
    capabilities: spec.capabilities,
    pricing: spec.pricing,
    vendorIds: { firstParty: spec.wireId },
    estimateTokens: estimateMetaTokens,
  }
  registrar.register(full)
  localCatalog.set(spec.id, {
    tags: spec.tags,
    contextWindow: spec.capabilities.contextWindow,
    displayName: spec.displayName,
  })
}

/** Register the full static Meta catalog (Responses preferred). */
export function registerMetaModels(registrar: ModelRegistrar): string[] {
  localCatalog.clear()

  // --- muse-spark-1.3: current flagship (Responses preferred)
  reg(registrar, {
    id: "muse-spark-1.3",
    surfaceId: "openai-responses",
    displayName: "Muse Spark 1.3",
    wireId: "muse-spark-1.3",
    aliases: ["muse-spark", "spark", "spark-1.3"],
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "flagship",
      "deep",
      "code",
      "vision",
      "multimodal",
      "video",
      "responses",
    ],
    capabilities: CAPS_MUSE_SPARK_1_3_RESPONSES,
    pricing: PRICING_MUSE_SPARK_1_3,
  })
  reg(registrar, {
    id: "muse-spark-1.3-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Muse Spark 1.3 (Chat)",
    wireId: "muse-spark-1.3",
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "code",
      "vision",
      "multimodal",
      "video",
      "chat",
    ],
    capabilities: CAPS_MUSE_SPARK_1_3_CHAT,
    pricing: PRICING_MUSE_SPARK_1_3,
  })

  // --- muse-spark-1.3-contributor (scout / cheap)
  reg(registrar, {
    id: "muse-spark-1.3-contributor",
    surfaceId: "openai-responses",
    displayName: "Muse Spark 1.3 Contributor",
    wireId: "muse-spark-1.3-contributor",
    aliases: ["spark-contributor", "muse-contributor", "spark-1.3-contributor"],
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "cheap",
      "scout",
      "contributor",
      "trains-on-data",
      "vision",
      "multimodal",
      "video",
      "responses",
    ],
    capabilities: CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_RESPONSES,
    pricing: PRICING_MUSE_SPARK_1_3_CONTRIBUTOR,
  })
  reg(registrar, {
    id: "muse-spark-1.3-contributor-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Muse Spark 1.3 Contributor (Chat)",
    wireId: "muse-spark-1.3-contributor",
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "contributor",
      "trains-on-data",
      "vision",
      "multimodal",
      "video",
      "chat",
    ],
    capabilities: CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_CHAT,
    pricing: PRICING_MUSE_SPARK_1_3_CONTRIBUTOR,
  })

  // --- muse-spark-1.2 (prior)
  reg(registrar, {
    id: "muse-spark-1.2",
    surfaceId: "openai-responses",
    displayName: "Muse Spark 1.2",
    wireId: "muse-spark-1.2",
    aliases: ["spark-1.2"],
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "code",
      "vision",
      "multimodal",
      "video",
      "responses",
    ],
    capabilities: CAPS_MUSE_SPARK_1_2_RESPONSES,
    pricing: PRICING_MUSE_SPARK_1_2,
  })
  reg(registrar, {
    id: "muse-spark-1.2-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Muse Spark 1.2 (Chat)",
    wireId: "muse-spark-1.2",
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "code",
      "vision",
      "multimodal",
      "video",
      "chat",
    ],
    capabilities: CAPS_MUSE_SPARK_1_2_CHAT,
    pricing: PRICING_MUSE_SPARK_1_2,
  })

  // --- muse-spark-1.1 (balanced)
  reg(registrar, {
    id: "muse-spark-1.1",
    surfaceId: "openai-responses",
    displayName: "Muse Spark 1.1",
    wireId: "muse-spark-1.1",
    aliases: ["spark-1.1"],
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "vision",
      "multimodal",
      "video",
      "balanced",
      "responses",
    ],
    capabilities: CAPS_MUSE_SPARK_1_1_RESPONSES,
    pricing: PRICING_MUSE_SPARK_1_1,
  })
  reg(registrar, {
    id: "muse-spark-1.1-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Muse Spark 1.1 (Chat)",
    wireId: "muse-spark-1.1",
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "vision",
      "multimodal",
      "video",
      "chat",
    ],
    capabilities: CAPS_MUSE_SPARK_1_1_CHAT,
    pricing: PRICING_MUSE_SPARK_1_1,
  })

  // --- muse-spark-1.2-contributor (prior contributor)
  reg(registrar, {
    id: "muse-spark-1.2-contributor",
    surfaceId: "openai-responses",
    displayName: "Muse Spark 1.2 Contributor",
    wireId: "muse-spark-1.2-contributor",
    aliases: ["spark-1.2-contributor"],
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "contributor",
      "trains-on-data",
      "vision",
      "multimodal",
      "video",
      "responses",
    ],
    capabilities: CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_RESPONSES,
    pricing: PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
  })
  reg(registrar, {
    id: "muse-spark-1.2-contributor-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Muse Spark 1.2 Contributor (Chat)",
    wireId: "muse-spark-1.2-contributor",
    tags: [
      "meta",
      "muse",
      "openai-compatible",
      "reasoning",
      "1m-context",
      "contributor",
      "trains-on-data",
      "vision",
      "multimodal",
      "video",
      "chat",
    ],
    capabilities: CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_CHAT,
    pricing: PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
  })

  registrar.setDefault(META_DEFAULT_MODEL_ID)
  return [...localCatalog.keys()]
}

function capsForAdHoc(id: string, isChat: boolean): Capabilities {
  if (/1\.3-contributor/i.test(id)) {
    return isChat ? CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_CHAT : CAPS_MUSE_SPARK_1_3_CONTRIBUTOR_RESPONSES
  }
  if (/1\.3/i.test(id)) {
    return isChat ? CAPS_MUSE_SPARK_1_3_CHAT : CAPS_MUSE_SPARK_1_3_RESPONSES
  }
  if (/1\.2-contributor/i.test(id)) {
    return isChat ? CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_CHAT : CAPS_MUSE_SPARK_1_2_CONTRIBUTOR_RESPONSES
  }
  if (/1\.1/i.test(id)) {
    return isChat ? CAPS_MUSE_SPARK_1_1_CHAT : CAPS_MUSE_SPARK_1_1_RESPONSES
  }
  return isChat ? CAPS_MUSE_SPARK_1_2_CHAT : CAPS_MUSE_SPARK_1_2_RESPONSES
}

function pricingForAdHoc(id: string): MTokRate {
  if (/contributor/i.test(id)) {
    return /1\.3/i.test(id)
      ? PRICING_MUSE_SPARK_1_3_CONTRIBUTOR
      : PRICING_MUSE_SPARK_1_2_CONTRIBUTOR
  }
  if (/1\.3/i.test(id)) return PRICING_MUSE_SPARK_1_3
  if (/1\.1/i.test(id)) return PRICING_MUSE_SPARK_1_1
  if (/1\.2/i.test(id)) return PRICING_MUSE_SPARK_1_2
  return PRICING_META_GENERIC
}

/** Register one Meta model (built-in companion or ad-hoc). */
export function registerMetaModel(spec: MetaModelSpec, registrar: ModelRegistrar): string {
  const surface = spec.surfaceId ?? "openai-responses"
  const wireId = spec.id.replace(/-chat$/i, "")
  const isChat = surface === "openai-chat-completions" || /-chat$/i.test(spec.id)
  const capabilities = capsForAdHoc(spec.id, isChat)
  const tags = spec.tags ?? ["meta", "openai-compatible", isChat ? "chat" : "responses"]
  const displayName = spec.displayName ?? spec.id
  reg(registrar, {
    id: spec.id,
    surfaceId: isChat ? "openai-chat-completions" : surface,
    displayName,
    wireId,
    aliases: spec.aliases,
    tags,
    capabilities,
    pricing: pricingForAdHoc(spec.id),
  })
  return spec.id
}

/** Find first registered model whose tags include every required tag. */
export function findMetaModelByTags(mustHave: readonly string[]): string | undefined {
  for (const [id, entry] of localCatalog) {
    if (mustHave.every((t) => entry.tags.includes(t))) return id
  }
  return undefined
}

/** Context window for a known model id (status bar). */
export function metaContextWindow(modelId: string): number | undefined {
  return localCatalog.get(modelId)?.contextWindow
}

/** Short label for status bar. */
export function metaModelShortLabel(modelId: string): string | undefined {
  return localCatalog.get(modelId)?.displayName ?? modelId
}

/** Built-in catalog ids (tests / diagnostics), Responses + Chat companions. */
export function listMetaBuiltinModelIds(): string[] {
  return [...BUILTIN_IDS]
}
