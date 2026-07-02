/**
 * Wafer model registry entries.
 *
 * All models register on the `openai-chat-completions` surface because
 * Wafer is an OpenAI-compatible gateway. This plugin reuses `llm-openai`'s
 * wire layer (translator, validator, header builder) — the same reuse
 * pattern as `llm-openrouter`.
 *
 * Model IDs are the exact strings returned by `GET /v1/models` (e.g.
 * `"GLM-5.1"`, `"deepseek-v4-pro"`). The catalog is registered at plugin
 * activation time via `registerWaferModels()`.
 *
 * @module llm/providers/wafer/models
 */

import {
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5_1,
  CAPS_GLM_5_2,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_MINIMAX_M3,
  CAPS_QWEN3_5_397B,
  CAPS_QWEN3_6_35B,
  CAPS_QWEN3_7_MAX,
} from "./capabilities.ts"
import type { ModelRegistrar } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5_1,
  PRICING_GLM_5_2,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_MINIMAX_M3,
  PRICING_QWEN3_5_397B,
  PRICING_QWEN3_6_35B,
  PRICING_QWEN3_7_MAX,
  PRICING_WAFER_GENERIC,
} from "./pricing.ts"

/**
 * Token estimator for Wafer models. Wafer proxies many upstream model
 * families (GLM, Kimi, Qwen, DeepSeek, MiniMax), each with their own
 * tokenizer. ~3.8 chars/token splits the difference and gives a
 * defensible estimate for the status bar.
 */
const estimateWaferTokens = makeCharRatioEstimator(3.8)

export interface WaferModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  pricing?: WaferPricing
}

/**
 * Pricing in cents-per-million (the shape Wafer's API returns).
 * Converted to USD-per-million when building the MTokRate.
 */
export interface WaferPricing {
  inputCentsPerMil: number
  outputCentsPerMil: number
  cacheReadCentsPerMil: number
}

/**
 * Built-in model catalog. Each entry is a model advertised by the live
 * `GET /v1/models` endpoint as of 2026-06-19.
 */
const BUILTIN_MODELS = [
  {
    id: "GLM-5.1",
    displayName: "GLM-5.1 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "balanced"],
    capabilities: CAPS_GLM_5_1,
    pricing: PRICING_GLM_5_1,
  },
  {
    id: "GLM-5.2",
    displayName: "GLM-5.2 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context"],
    capabilities: CAPS_GLM_5_2,
    pricing: PRICING_GLM_5_2,
  },
  {
    id: "Kimi-K2.6",
    displayName: "Kimi-K2.6 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "balanced"],
    capabilities: CAPS_KIMI_K2_6,
    pricing: PRICING_KIMI_K2_6,
  },
  {
    id: "Kimi-K2.7-Code",
    displayName: "Kimi-K2.7-Code (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "code"],
    capabilities: CAPS_KIMI_K2_7_CODE,
    pricing: PRICING_KIMI_K2_7_CODE,
  },
  {
    id: "Qwen3.5-397B-A17B",
    displayName: "Qwen3.5-397B (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "balanced"],
    capabilities: CAPS_QWEN3_5_397B,
    pricing: PRICING_QWEN3_5_397B,
  },
  {
    id: "Qwen3.6-35B-A3B",
    displayName: "Qwen3.6-35B (Wafer)",
    tags: ["wafer", "openai-compatible", "cheap"],
    capabilities: CAPS_QWEN3_6_35B,
    pricing: PRICING_QWEN3_6_35B,
  },
  {
    id: "qwen3.7-max",
    displayName: "Qwen3.7-Max (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "flagship"],
    capabilities: CAPS_QWEN3_7_MAX,
    pricing: PRICING_QWEN3_7_MAX,
  },
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "cheap", "scout"],
    capabilities: CAPS_DEEPSEEK_V4_FLASH,
    pricing: PRICING_DEEPSEEK_V4_FLASH,
  },
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "flagship", "deep"],
    capabilities: CAPS_DEEPSEEK_V4_PRO,
    pricing: PRICING_DEEPSEEK_V4_PRO,
  },
  {
    id: "MiniMax-M3",
    displayName: "MiniMax-M3 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context"],
    capabilities: CAPS_MINIMAX_M3,
    pricing: PRICING_MINIMAX_M3,
  },
]

/**
 * Local catalog of id to tags-plus-context-window captured at registration, so
 * the adapter's `recommendSubagentModels` and session-info can read THIS
 * provider's own catalog by tag / context window without a host-registry
 * round-trip (the old `findModelByTags` / `resolveModel` from `src/`).
 */
interface LocalCatalogEntry {
  tags: readonly string[]
  contextWindow: number
}
const localCatalog = new Map<string, LocalCatalogEntry>()

/**
 * Populate the registry with the full Wafer catalog through the setup-context
 * registrar (the `models:register` capability). Taking the registrar as a
 * parameter (rather than importing the global `registerModel` from `src/`) is
 * what lets this provider live in its own repo. Idempotent (last-write-wins).
 *
 * @param registrar - Host model registrar (the `models:register` capability).
 * @returns The registered model ids.
 */
export function registerWaferModels(registrar: ModelRegistrar): string[] {
  const ids: string[] = []
  for (const m of BUILTIN_MODELS) {
    registerWaferModel({ id: m.id, displayName: m.displayName, tags: m.tags }, registrar)
    ids.push(m.id)
  }
  return ids
}

/**
 * Register a single Wafer model into the given registrar. Used for the
 * built-in catalog and for ad-hoc models that the static snapshot does not
 * know yet. Also records the model's tags + context window in the local
 * catalog so `findWaferModelByTags` and `waferContextWindow` resolve locally.
 */
export function registerWaferModel(spec: WaferModelSpec, registrar: ModelRegistrar): string {
  const builtin = BUILTIN_MODELS.find((m) => m.id === spec.id)
  const tags = spec.tags ?? ["wafer", "openai-compatible"]
  const capabilities = builtin?.capabilities ?? CAPS_GLM_5_1
  registrar.register({
    id: spec.id,
    providerId: "wafer",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? spec.id,
    tags,
    capabilities,
    estimateTokens: estimateWaferTokens,
    pricing: builtin?.pricing ?? PRICING_WAFER_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  localCatalog.set(spec.id, { tags, contextWindow: capabilities.contextWindow })
  return spec.id
}

/**
 * Find a registered Wafer model id whose tags include every tag in `mustHave`,
 * reading THIS provider's local catalog (no host-registry read). Returns the
 * first matching id, or undefined.
 */
export function findWaferModelByTags(mustHave: readonly string[]): string | undefined {
  for (const [id, entry] of localCatalog) {
    if (mustHave.every((t) => entry.tags.includes(t))) return id
  }
  return undefined
}

/**
 * The context window for a registered Wafer model id, from the local catalog.
 * Returns undefined for an unknown id (the caller degrades gracefully).
 */
export function waferContextWindow(modelId: string): number | undefined {
  return localCatalog.get(modelId)?.contextWindow
}

/** Wafer's short provider code for compact UI labels. */
const WAFER_SHORT_CODE = "wf"

/**
 * Parse the version token out of a Wafer model id (the naming scheme Wafer
 * owns, mirroring the adapter's `modelVersionToken` hook): strip the leading
 * family prefix so `GLM-5.1` becomes `5.1`, `deepseek-v4-pro` becomes `v4-pro`.
 */
export function waferModelVersionToken(modelId: string): string {
  return modelId.replace(/^(GLM|Kimi|Qwen|qwen|deepseek|MiniMax)-?/, "")
}

/**
 * Compact provider-tagged label for a Wafer model id (`wf-<token>`), computed
 * locally from Wafer's OWN short code + version scheme. Replaces the host
 * `modelShortLabel` (which reads the shared registry) for the status-bar slot.
 * Returns just the short code when no distinct token can be parsed, and `""`
 * for empty input.
 */
export function waferModelShortLabel(modelId: string): string {
  if (!modelId) return ""
  const token = waferModelVersionToken(modelId)
  return token && token !== WAFER_SHORT_CODE ? `${WAFER_SHORT_CODE}-${token}` : WAFER_SHORT_CODE
}
