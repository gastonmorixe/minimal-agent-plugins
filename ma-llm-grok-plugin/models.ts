/**
 * Grok / xAI model registry — dual-surface where appropriate.
 *
 * Pattern from `ma-llm-openai-plugin/models.ts`: preferred surface is
 * Responses for frontier models (`grok-4.5`); Chat Completions variants use
 * a `-chat` suffix. `vendorIds.firstParty` is always the wire model id.
 *
 * @module llm/providers/grok/models
 */

import {
  CAPS_GROK_45_CHAT,
  CAPS_GROK_45_RESPONSES,
  CAPS_GROK_BUILD_CHAT,
  CAPS_GROK_BUILD_RESPONSES,
  CAPS_GROK_COMPOSER_25_FAST,
  CAPS_GROK_GENERIC,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_GROK_45,
  PRICING_GROK_BUILD,
  PRICING_GROK_COMPOSER_25_FAST,
  PRICING_GROK_GENERIC,
} from "./pricing.ts"

const estimateGrokTokens = makeCharRatioEstimator(3.5)

const localCatalog: Array<{ id: string; tags: readonly string[]; contextWindow: number }> = []

export interface GrokModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  surfaceId?: "openai-chat-completions" | "openai-responses"
}

export function findGrokModelByTags(mustHave: readonly string[]): string | undefined {
  return localCatalog.find((m) => mustHave.every((t) => m.tags.includes(t)))?.id
}

export function grokContextWindow(modelId: string): number | undefined {
  return localCatalog.find((m) => m.id === modelId)?.contextWindow
}

export function grokModelShortLabel(modelId: string): string {
  const m = modelId.replace(/^grok-?/i, "").replace(/-chat$/i, "")
  return m || "grok"
}

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
    knowledgeCutoff?: string
  },
): void {
  const full: ProviderModelSpec = {
    id: spec.id,
    aliases: spec.aliases,
    providerId: "grok",
    surfaceId: spec.surfaceId,
    displayName: spec.displayName,
    knowledgeCutoff: spec.knowledgeCutoff,
    tags: spec.tags,
    capabilities: spec.capabilities,
    pricing: spec.pricing,
    vendorIds: { firstParty: spec.wireId },
    estimateTokens: estimateGrokTokens,
  }
  registrar.register(full)
  localCatalog.push({
    id: spec.id,
    tags: spec.tags,
    contextWindow: spec.capabilities.contextWindow,
  })
}

/**
 * Register the full Grok catalog (Responses preferred for frontier).
 */
export function registerGrokModels(registrar: ModelRegistrar): string[] {
  localCatalog.length = 0

  // --- grok-4.5: Responses preferred (matches cli-chat-proxy / catalog api_backend)
  reg(registrar, {
    id: "grok-4.5",
    surfaceId: "openai-responses",
    displayName: "Grok 4.5",
    wireId: "grok-4.5",
    aliases: ["grok-4", "grok4.5"],
    tags: ["grok", "xai", "flagship", "deep", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_45_RESPONSES,
    pricing: PRICING_GROK_45,
  })
  reg(registrar, {
    id: "grok-4.5-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Grok 4.5 (Chat)",
    wireId: "grok-4.5",
    tags: ["grok", "xai", "flagship", "reasoning", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_45_CHAT,
    pricing: PRICING_GROK_45,
  })

  // --- grok-build
  reg(registrar, {
    id: "grok-build",
    surfaceId: "openai-responses",
    displayName: "Grok Build",
    wireId: "grok-build",
    aliases: ["grok-code", "grok-build-latest"],
    tags: ["grok", "xai", "balanced", "code", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_BUILD_RESPONSES,
    pricing: PRICING_GROK_BUILD,
  })
  reg(registrar, {
    id: "grok-build-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Grok Build (Chat)",
    wireId: "grok-build",
    tags: ["grok", "xai", "balanced", "code", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_BUILD_CHAT,
    pricing: PRICING_GROK_BUILD,
  })

  // --- composer: chat-only (fast coding)
  reg(registrar, {
    id: "grok-composer-2.5-fast",
    surfaceId: "openai-chat-completions",
    displayName: "Composer 2.5 Fast",
    wireId: "grok-composer-2.5-fast",
    aliases: ["composer-2.5-fast", "grok-composer"],
    tags: ["grok", "xai", "cheap", "scout", "code", "fast", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_COMPOSER_25_FAST,
    pricing: PRICING_GROK_COMPOSER_25_FAST,
  })

  registrar.setDefault("grok-4.5")
  return localCatalog.map((m) => m.id)
}

export function registerGrokModel(spec: GrokModelSpec, registrar: ModelRegistrar): void {
  const surface = spec.surfaceId ?? "openai-chat-completions"
  reg(registrar, {
    id: spec.id,
    surfaceId: surface,
    displayName: spec.displayName ?? spec.id,
    wireId: spec.id.replace(/-chat$/i, ""),
    tags: spec.tags ?? ["grok", "xai", "ad-hoc", "vision", "tools"],
    capabilities: CAPS_GROK_GENERIC,
    pricing: PRICING_GROK_GENERIC,
  })
}

/** Into-style helper used by ad-hoc registration (OpenRouter pattern). */
export function registerGrokModelInto(
  registrar: ModelRegistrar,
  spec: GrokModelSpec,
): void {
  registerGrokModel(spec, registrar)
}
