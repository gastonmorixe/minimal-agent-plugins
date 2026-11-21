/**
 * Wafer model registry entries.
 *
 * All models register on the `openai-chat-completions` surface because
 * Wafer is an OpenAI-compatible gateway. This plugin reuses `llm-openai`'s
 * wire layer (translator, validator, header builder) — the same reuse
 * pattern as `llm-openrouter`.
 *
 * Model IDs are the exact strings returned by `GET /v1/models` (e.g.
 * `"GLM-5.3"`, `"DeepSeek-V4-Flash-0731-Fast"`). The catalog is registered at plugin
 * activation time via `registerWaferModels()`.
 *
 * Catalog snapshot: live `GET https://pass.wafer.ai/v1/models` as of
 * 2026-11-18 (13 entries, all with a `wafer` metadata block, all
 * registered). Only entries with a `wafer` metadata block are registered.
 * Wafer serves dated checkpoints (`-0423`, `-1017`) as distinct SKUs with
 * their own rates, so they register as separate models. Ids that left the
 * live list (`GLM-5.1`, `Kimi-K2.6`, `MiniMax-M3`, `glm5.2-fast`,
 * `kimi-k3-fast`) are removed: this plugin has no former-id mechanism, and an
 * unknown id still works on the wire through {@link registerWaferModel}.
 *
 * @module llm/providers/wafer/models
 */

import type { ModelRegistrar } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForModelId } from "../ma-token-estimate-kit/src/index.ts"

import {
  CAPS_DEEPSEEK_V4_1_FLASH,
  CAPS_DEEPSEEK_V4_FLASH_0423,
  CAPS_DEEPSEEK_V4_FLASH_0731_FAST,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5_2,
  CAPS_GLM_5_3,
  CAPS_GLM_5_3_FLASH,
  CAPS_KIMI_K3,
  CAPS_KIMI_K3_1_PRO,
  CAPS_MINIMAX_M3_1_FLASH,
  CAPS_QWEN3_8_27B,
} from "./capabilities.ts"
import {
  PRICING_DEEPSEEK_V4_1_FLASH,
  PRICING_DEEPSEEK_V4_1_FLASH_1017,
  PRICING_DEEPSEEK_V4_FLASH_0423,
  PRICING_DEEPSEEK_V4_FLASH_0731_FAST,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5_2,
  PRICING_GLM_5_3,
  PRICING_GLM_5_3_FLASH,
  PRICING_KIMI_K3,
  PRICING_KIMI_K3_1_PRO,
  PRICING_MINIMAX_M3_1_FLASH,
  PRICING_QWEN3_8_27B,
  PRICING_WAFER_GENERIC,
} from "./pricing.ts"

/**
 * Fallback tokenizer family for a model id that the kit map does not know.
 * Wafer serves models of many vendors (GLM, Kimi, MiniMax, DeepSeek, Qwen, ...), so `generic` (the fit on the union of 12 reference tokenizers)
 * is the safest guess.
 */
const WAFER_FALLBACK_FAMILY = "generic" as const

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
 * `GET /v1/models` endpoint (with a `wafer` block) as of 2026-11-18.
 * The first entry is the default. Role tags: scout = `cheap` + `scout`
 * (GLM-5.3-Flash), balanced = `balanced` (GLM-5.2), deep = `flagship` +
 * `deep` (GLM-5.3).
 */
const BUILTIN_MODELS = [
  {
    id: "GLM-5.2",
    displayName: "GLM-5.2 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context", "balanced"],
    capabilities: CAPS_GLM_5_2,
    pricing: PRICING_GLM_5_2,
  },
  {
    id: "GLM-5.3",
    displayName: "GLM-5.3 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context", "flagship", "deep"],
    capabilities: CAPS_GLM_5_3,
    pricing: PRICING_GLM_5_3,
  },
  {
    id: "GLM-5.3-Flash",
    displayName: "GLM-5.3-Flash (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context", "cheap", "scout"],
    capabilities: CAPS_GLM_5_3_FLASH,
    pricing: PRICING_GLM_5_3_FLASH,
  },
  {
    id: "Kimi-K3",
    displayName: "Kimi-K3 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context"],
    capabilities: CAPS_KIMI_K3,
    pricing: PRICING_KIMI_K3,
  },
  {
    id: "Kimi-K3.1-Pro",
    displayName: "Kimi-K3.1-Pro (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context"],
    capabilities: CAPS_KIMI_K3_1_PRO,
    pricing: PRICING_KIMI_K3_1_PRO,
  },
  {
    id: "Kimi-K3.1-Pro-US",
    displayName: "Kimi-K3.1-Pro (US) (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context"],
    capabilities: CAPS_KIMI_K3_1_PRO,
    pricing: PRICING_KIMI_K3_1_PRO,
  },
  {
    id: "MiniMax-M3.1-Flash",
    displayName: "MiniMax-M3.1-Flash (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context", "cheap"],
    capabilities: CAPS_MINIMAX_M3_1_FLASH,
    pricing: PRICING_MINIMAX_M3_1_FLASH,
  },
  {
    id: "DeepSeek-V4-Pro",
    displayName: "DeepSeek-V4-Pro (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context"],
    capabilities: CAPS_DEEPSEEK_V4_PRO,
    pricing: PRICING_DEEPSEEK_V4_PRO,
  },
  {
    id: "DeepSeek-V4.1-Flash",
    displayName: "DeepSeek-V4.1-Flash (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context", "cheap"],
    capabilities: CAPS_DEEPSEEK_V4_1_FLASH,
    pricing: PRICING_DEEPSEEK_V4_1_FLASH,
  },
  {
    id: "DeepSeek-V4.1-Flash-1017",
    displayName: "DeepSeek-V4.1-Flash-1017 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "1m-context", "cheap"],
    capabilities: CAPS_DEEPSEEK_V4_1_FLASH,
    pricing: PRICING_DEEPSEEK_V4_1_FLASH_1017,
  },
  {
    id: "DeepSeek-V4-Flash-0423",
    displayName: "DeepSeek-V4-Flash-0423 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context", "cheap", "fast"],
    capabilities: CAPS_DEEPSEEK_V4_FLASH_0423,
    pricing: PRICING_DEEPSEEK_V4_FLASH_0423,
  },
  {
    id: "DeepSeek-V4-Flash-0731-Fast",
    displayName: "DeepSeek-V4-Flash-0731-Fast (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context", "cheap", "fast"],
    capabilities: CAPS_DEEPSEEK_V4_FLASH_0731_FAST,
    pricing: PRICING_DEEPSEEK_V4_FLASH_0731_FAST,
  },
  {
    id: "Qwen3.8-27B",
    displayName: "Qwen3.8-27B (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "cheap"],
    capabilities: CAPS_QWEN3_8_27B,
    pricing: PRICING_QWEN3_8_27B,
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
  const capabilities = builtin?.capabilities ?? CAPS_GLM_5_2
  registrar.register({
    id: spec.id,
    providerId: "wafer",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? spec.id,
    tags,
    capabilities,
    estimateTokens: estimatorForModelId(spec.id, WAFER_FALLBACK_FAMILY),
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
 * family prefix so `GLM-5.3` becomes `5.3`, `Kimi-K3.1-Pro` becomes `K3.1-Pro`,
 * `DeepSeek-V4-Pro` becomes `V4-Pro`, `Qwen3.8-27B` becomes `3.8-27B`.
 */
export function waferModelVersionToken(modelId: string): string {
  return modelId.replace(/^(GLM|glm|Kimi|kimi|Qwen|qwen|DeepSeek|deepseek|MiniMax)-?/, "")
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
