/**
 * Grok / xAI model registry — dual-surface where appropriate.
 *
 * Catalog reconciled 2026-07-30 from live probe (**grok-oauth-9**):
 * - `cli-chat-proxy` `/v1/models` (subscription): `grok-4.5` only — do **not**
 *   drop API-catalog entries solely because OAuth omits them.
 * - `api.x.ai/v1/models` + language-models merge: text SKUs, `context_length`,
 *   `input_modalities`/`output_modalities`, price micros, `aliases`. Imagine
 *   image/video SKUs omitted (not agent chat surfaces).
 * - Effort ladders: `/v1/models` and language-models do **not** expose them;
 *   cli-models exposes `reasoning_efforts` for `grok-4.5` only (see
 *   capabilities.ts). Other models keep docs-derived effort/thinking caps.
 *
 * Aliases: stable live names + local conveniences; date-stamped wire ids as
 * aliases where the local id is the short form. Beta/experimental/gv2 aliases
 * omitted to avoid collisions.
 *
 * Pattern from `ma-llm-openai-plugin/models.ts`: preferred surface is
 * Responses for frontier models (`grok-4.5`); Chat Completions variants use
 * a `-chat` suffix. `vendorIds.firstParty` is always the wire model id.
 *
 * @module llm/providers/grok/models
 */

import {
  CAPS_GROK_43_CHAT,
  CAPS_GROK_43_RESPONSES,
  CAPS_GROK_45_CHAT,
  CAPS_GROK_45_RESPONSES,
  CAPS_GROK_46_CHAT,
  CAPS_GROK_46_RESPONSES,
  CAPS_GROK_420_MULTI_AGENT,
  CAPS_GROK_420_NON_REASONING,
  CAPS_GROK_BUILD_CHAT,
  CAPS_GROK_BUILD_RESPONSES,
  CAPS_GROK_GENERIC,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_GROK_43,
  PRICING_GROK_45,
  PRICING_GROK_46,
  PRICING_GROK_420,
  PRICING_GROK_BUILD,
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

/** Find the first registered Grok model id that carries every required tag. */
export function findGrokModelByTags(mustHave: readonly string[]): string | undefined {
  return localCatalog.find((m) => mustHave.every((t) => m.tags.includes(t)))?.id
}

/** Context window tokens for a known Grok model id, when present in the catalog. */
export function grokContextWindow(modelId: string): number | undefined {
  return localCatalog.find((m) => m.id === modelId)?.contextWindow
}

/** Compact label for status UI (`xai-<token>`), stripped of the `grok` / `-chat` noise. */
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

  // --- grok-4.6: Responses preferred (authenticated cli-models + xAI docs)
  reg(registrar, {
    id: "grok-4.6",
    surfaceId: "openai-responses",
    displayName: "Grok 4.6",
    wireId: "grok-4.6",
    aliases: ["grok-4.6-latest"],
    tags: ["grok", "xai", "flagship", "deep", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_46_RESPONSES,
    pricing: PRICING_GROK_46,
  })
  reg(registrar, {
    id: "grok-4.6-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Grok 4.6 (Chat)",
    wireId: "grok-4.6",
    tags: ["grok", "xai", "flagship", "reasoning", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_46_CHAT,
    pricing: PRICING_GROK_46,
  })

  // --- grok-4.5: Responses preferred (cli-chat-proxy + api.x.ai)
  reg(registrar, {
    id: "grok-4.5",
    surfaceId: "openai-responses",
    displayName: "Grok 4.5",
    wireId: "grok-4.5",
    aliases: ["grok-4", "grok4.5", "grok-4.5-latest", "grok-build-latest"],
    tags: ["grok", "xai", "flagship", "deep", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_45_RESPONSES,
    pricing: PRICING_GROK_45,
    knowledgeCutoff: "2026-02-01",
  })
  reg(registrar, {
    id: "grok-4.5-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Grok 4.5 (Chat)",
    wireId: "grok-4.5",
    tags: ["grok", "xai", "flagship", "reasoning", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_45_CHAT,
    pricing: PRICING_GROK_45,
    knowledgeCutoff: "2026-02-01",
  })

  // --- grok-build-0.1 (wire); local id keeps `grok-build`
  reg(registrar, {
    id: "grok-build",
    surfaceId: "openai-responses",
    displayName: "Grok Build",
    wireId: "grok-build-0.1",
    aliases: [
      "grok-build-0.1",
      "grok-code",
      "grok-code-fast",
      "grok-code-fast-1",
      "grok-code-fast-1-0825",
    ],
    tags: ["grok", "xai", "balanced", "code", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_BUILD_RESPONSES,
    pricing: PRICING_GROK_BUILD,
  })
  reg(registrar, {
    id: "grok-build-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Grok Build (Chat)",
    wireId: "grok-build-0.1",
    tags: ["grok", "xai", "balanced", "code", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_BUILD_CHAT,
    pricing: PRICING_GROK_BUILD,
  })

  // --- grok-4.3
  reg(registrar, {
    id: "grok-4.3",
    surfaceId: "openai-responses",
    displayName: "Grok 4.3",
    wireId: "grok-4.3",
    aliases: ["grok-4.3-latest", "grok-latest"],
    tags: ["grok", "xai", "balanced", "fast", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_43_RESPONSES,
    pricing: PRICING_GROK_43,
  })
  reg(registrar, {
    id: "grok-4.3-chat",
    surfaceId: "openai-chat-completions",
    displayName: "Grok 4.3 (Chat)",
    wireId: "grok-4.3",
    tags: ["grok", "xai", "balanced", "fast", "reasoning", "vision", "tools", "chat"],
    capabilities: CAPS_GROK_43_CHAT,
    pricing: PRICING_GROK_43,
  })

  // --- grok-4.20 family (api.x.ai; local ids = short live aliases)
  reg(registrar, {
    id: "grok-4.20-reasoning",
    surfaceId: "openai-responses",
    displayName: "Grok 4.20 Reasoning",
    wireId: "grok-4.20-0309-reasoning",
    // live: grok-4.20, grok-4.20-reasoning-latest, grok-4.20-0309, …betas omitted
    aliases: [
      "grok-4.20",
      "grok-4.20-0309",
      "grok-4.20-0309-reasoning",
      "grok-4.20-reasoning-latest",
    ],
    tags: ["grok", "xai", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_43_RESPONSES,
    pricing: PRICING_GROK_420,
  })
  reg(registrar, {
    id: "grok-4.20-non-reasoning",
    surfaceId: "openai-responses",
    displayName: "Grok 4.20 Non-Reasoning",
    wireId: "grok-4.20-0309-non-reasoning",
    // live short name is this id; keep wire + *-latest (betas omitted)
    aliases: ["grok-4.20-0309-non-reasoning", "grok-4.20-non-reasoning-latest"],
    tags: ["grok", "xai", "fast", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_420_NON_REASONING,
    pricing: PRICING_GROK_420,
  })
  reg(registrar, {
    id: "grok-4.20-multi-agent",
    surfaceId: "openai-responses",
    displayName: "Grok 4.20 Multi-Agent",
    wireId: "grok-4.20-multi-agent-0309",
    // live short name is this id; keep wire + *-latest (betas omitted)
    aliases: ["grok-4.20-multi-agent-0309", "grok-4.20-multi-agent-latest"],
    tags: ["grok", "xai", "multi-agent", "reasoning", "vision", "tools", "responses"],
    capabilities: CAPS_GROK_420_MULTI_AGENT,
    pricing: PRICING_GROK_420,
  })

  registrar.setDefault("grok-4.6")
  return localCatalog.map((m) => m.id)
}

/** Register one Grok model (static catalog entry or ad-hoc live id). */
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
export function registerGrokModelInto(registrar: ModelRegistrar, spec: GrokModelSpec): void {
  registerGrokModel(spec, registrar)
}
