/**
 * ClinePass model registry entries.
 *
 * Model IDs use the full gateway slug (`cline-pass/...`) because that is what
 * `POST /api/v1/chat/completions` expects in the `model` field. Catalog is
 * static (live `/models` is unreliable for Pass-only third parties).
 *
 * @module llm/providers/clinepass/models
 */

import {
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5_2,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_MIMO_V2_5,
  CAPS_MIMO_V2_5_PRO,
  CAPS_MINIMAX_M3,
  CAPS_QWEN3_7_MAX,
  CAPS_QWEN3_7_PLUS,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import type { ModelRegistrar } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_CLINEPASS_GENERIC,
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5_2,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_MIMO_V2_5,
  PRICING_MIMO_V2_5_PRO,
  PRICING_MINIMAX_M3,
  PRICING_QWEN3_7_MAX,
  PRICING_QWEN3_7_PLUS,
} from "./pricing.ts"

const estimateClinepassTokens = makeCharRatioEstimator(3.8)

export interface ClinepassModelSpec {
  id: string
  displayName?: string
  tags?: string[]
}

interface BuiltinModel {
  id: string
  displayName: string
  tags: string[]
  capabilities: Capabilities
  pricing: MTokRate
}

/**
 * Full ClinePass catalog (10 models) as of Cline docs + generated catalog.
 * IDs must be sent exactly as listed.
 * Kimi K3 not yet on ClinePass as of 2026-07-16 (docs.cline.bot/getting-started/clinepass).
 */
const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: "cline-pass/glm-5.2",
    displayName: "GLM 5.2 (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "flagship", "deep"],
    capabilities: CAPS_GLM_5_2,
    pricing: PRICING_GLM_5_2,
  },
  {
    id: "cline-pass/kimi-k2.7-code",
    displayName: "Kimi K2.7 Code (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "code", "vision", "balanced"],
    capabilities: CAPS_KIMI_K2_7_CODE,
    pricing: PRICING_KIMI_K2_7_CODE,
  },
  {
    id: "cline-pass/kimi-k2.6",
    displayName: "Kimi K2.6 (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "vision", "balanced"],
    capabilities: CAPS_KIMI_K2_6,
    pricing: PRICING_KIMI_K2_6,
  },
  {
    id: "cline-pass/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "flagship", "deep"],
    capabilities: CAPS_DEEPSEEK_V4_PRO,
    pricing: PRICING_DEEPSEEK_V4_PRO,
  },
  {
    id: "cline-pass/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "cheap", "scout"],
    capabilities: CAPS_DEEPSEEK_V4_FLASH,
    pricing: PRICING_DEEPSEEK_V4_FLASH,
  },
  {
    id: "cline-pass/minimax-m3",
    displayName: "MiniMax M3 (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "vision", "balanced"],
    capabilities: CAPS_MINIMAX_M3,
    pricing: PRICING_MINIMAX_M3,
  },
  {
    id: "cline-pass/mimo-v2.5-pro",
    displayName: "MiMo V2.5 Pro (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "flagship"],
    capabilities: CAPS_MIMO_V2_5_PRO,
    pricing: PRICING_MIMO_V2_5_PRO,
  },
  {
    id: "cline-pass/mimo-v2.5",
    displayName: "MiMo V2.5 (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "cheap", "vision"],
    capabilities: CAPS_MIMO_V2_5,
    pricing: PRICING_MIMO_V2_5,
  },
  {
    id: "cline-pass/qwen3.7-max",
    displayName: "Qwen3.7 Max (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "flagship", "deep"],
    capabilities: CAPS_QWEN3_7_MAX,
    pricing: PRICING_QWEN3_7_MAX,
  },
  {
    id: "cline-pass/qwen3.7-plus",
    displayName: "Qwen3.7 Plus (ClinePass)",
    tags: ["clinepass", "openai-compatible", "reasoning", "1m-context", "vision", "balanced"],
    capabilities: CAPS_QWEN3_7_PLUS,
    pricing: PRICING_QWEN3_7_PLUS,
  },
]

interface LocalCatalogEntry {
  tags: readonly string[]
  contextWindow: number
}
const localCatalog = new Map<string, LocalCatalogEntry>()

/** Register the full static ClinePass catalog. */
export function registerClinepassModels(registrar: ModelRegistrar): string[] {
  const ids: string[] = []
  for (const m of BUILTIN_MODELS) {
    registerClinepassModel({ id: m.id, displayName: m.displayName, tags: m.tags }, registrar)
    ids.push(m.id)
  }
  return ids
}

/** Register one ClinePass model (built-in or ad-hoc). */
export function registerClinepassModel(
  spec: ClinepassModelSpec,
  registrar: ModelRegistrar,
): string {
  const builtin = BUILTIN_MODELS.find((m) => m.id === spec.id)
  const tags = spec.tags ?? ["clinepass", "openai-compatible"]
  const capabilities = builtin?.capabilities ?? CAPS_GLM_5_2
  registrar.register({
    id: spec.id,
    providerId: "clinepass",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? builtin?.displayName ?? spec.id,
    tags,
    capabilities,
    estimateTokens: estimateClinepassTokens,
    pricing: builtin?.pricing ?? PRICING_CLINEPASS_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  localCatalog.set(spec.id, { tags, contextWindow: capabilities.contextWindow })
  return spec.id
}

/** Find first registered model whose tags include every required tag. */
export function findClinepassModelByTags(mustHave: readonly string[]): string | undefined {
  for (const [id, entry] of localCatalog) {
    if (mustHave.every((t) => entry.tags.includes(t))) return id
  }
  return undefined
}

/** Context window for a registered model id. */
export function clinepassContextWindow(modelId: string): number | undefined {
  return localCatalog.get(modelId)?.contextWindow
}

const CLINEPASS_SHORT_CODE = "cp"

/** Version token from a full slug: `cline-pass/glm-5.2` → `glm-5.2`. */
export function clinepassModelVersionToken(modelId: string): string {
  const slash = modelId.lastIndexOf("/")
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

/** Compact status-bar label (`cp-glm-5.2`). */
export function clinepassModelShortLabel(modelId: string): string {
  if (!modelId) return ""
  const token = clinepassModelVersionToken(modelId)
  return token ? `${CLINEPASS_SHORT_CODE}-${token}` : CLINEPASS_SHORT_CODE
}

/** All built-in model ids (for tests / docs). */
export function listClinepassBuiltinModelIds(): string[] {
  return BUILTIN_MODELS.map((m) => m.id)
}
