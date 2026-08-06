/**
 * Meta Muse Spark model registry.
 *
 * Wire model ids are the bare Meta slugs (`muse-spark-1.2`, …) because that is
 * what `POST /v1/chat/completions` expects. Catalog confirmed via live
 * `GET /v1/models` on 2026-08-05.
 *
 * @module llm/providers/meta/models
 */

import {
  CAPS_MUSE_SPARK_1_1,
  CAPS_MUSE_SPARK_1_2,
  CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import type { ModelRegistrar } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_META_GENERIC,
  PRICING_MUSE_SPARK_1_1,
  PRICING_MUSE_SPARK_1_2,
  PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
} from "./pricing.ts"

const estimateMetaTokens = makeCharRatioEstimator(3.8)

export interface MetaModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  aliases?: string[]
}

interface BuiltinModel {
  id: string
  displayName: string
  aliases?: string[]
  tags: string[]
  capabilities: Capabilities
  pricing: MTokRate
}

/**
 * Live catalog (2026-08-05 `GET /v1/models`):
 * muse-spark-1.2-contributor, muse-spark-1.2, muse-spark-1.1
 */
const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: "muse-spark-1.2",
    displayName: "Muse Spark 1.2",
    aliases: ["muse-spark", "spark", "spark-1.2"],
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
    ],
    capabilities: CAPS_MUSE_SPARK_1_2,
    pricing: PRICING_MUSE_SPARK_1_2,
  },
  {
    id: "muse-spark-1.1",
    displayName: "Muse Spark 1.1",
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
    ],
    capabilities: CAPS_MUSE_SPARK_1_1,
    pricing: PRICING_MUSE_SPARK_1_1,
  },
  {
    id: "muse-spark-1.2-contributor",
    displayName: "Muse Spark 1.2 Contributor",
    aliases: ["spark-contributor", "muse-contributor"],
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
    ],
    capabilities: CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
    pricing: PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
  },
]

interface LocalCatalogEntry {
  tags: readonly string[]
  contextWindow: number
  displayName: string
}
const localCatalog = new Map<string, LocalCatalogEntry>()

/** Default model id for new Meta sessions. */
export const META_DEFAULT_MODEL_ID = "muse-spark-1.2"

/** Register the full static Meta catalog. */
export function registerMetaModels(registrar: ModelRegistrar): string[] {
  const ids: string[] = []
  for (const m of BUILTIN_MODELS) {
    registerMetaModel(
      { id: m.id, displayName: m.displayName, tags: m.tags, aliases: m.aliases },
      registrar,
    )
    ids.push(m.id)
  }
  registrar.setDefault(META_DEFAULT_MODEL_ID)
  return ids
}

/** Register one Meta model (built-in or ad-hoc). */
export function registerMetaModel(spec: MetaModelSpec, registrar: ModelRegistrar): string {
  const builtin = BUILTIN_MODELS.find((m) => m.id === spec.id)
  const tags = spec.tags ?? ["meta", "openai-compatible"]
  const capabilities = builtin?.capabilities ?? CAPS_MUSE_SPARK_1_2
  const displayName = spec.displayName ?? builtin?.displayName ?? spec.id
  registrar.register({
    id: spec.id,
    aliases: spec.aliases ?? builtin?.aliases,
    providerId: "meta",
    surfaceId: "openai-chat-completions",
    displayName,
    tags,
    capabilities,
    estimateTokens: estimateMetaTokens,
    pricing: builtin?.pricing ?? PRICING_META_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  localCatalog.set(spec.id, {
    tags,
    contextWindow: capabilities.contextWindow,
    displayName,
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

/** Built-in catalog ids (tests / diagnostics). */
export function listMetaBuiltinModelIds(): string[] {
  return BUILTIN_MODELS.map((m) => m.id)
}
