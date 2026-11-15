/**
 * OpenRouter model registry entries.
 *
 * OpenRouter ids are namespaced slugs (`moonshotai/kimi-k3.1-pro`,
 * `deepseek/deepseek-v4.1-flash`, ...). All register on the SHARED
 * `openai-chat-completions` surface — OpenRouter normalizes every upstream model to
 * the OpenAI Chat Completions wire format, so the DeepSeek/OpenAI chat
 * translator handles them unchanged. Only a representative few are
 * registered (snapshot as of 2026-11-15); any other slug still works on
 * the wire (the CLI doesn't gate on the registry), just without a local
 * cost estimate.
 *
 * @module llm/providers/openrouter/models
 */

import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { ModelRegistrar } from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"

import {
  CAPS_OPENROUTER_CHAT,
  CAPS_OR_CLAUDE_OPUS_55,
  CAPS_OR_CLAUDE_SONNET_55,
  CAPS_OR_DEEPSEEK_V41_FLASH,
  CAPS_OR_GPT_4O_MINI,
  CAPS_OR_GPT_61_SOL,
  CAPS_OR_GROK_47,
  CAPS_OR_KIMI_K31_PRO,
} from "./capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import {
  PRICING_OR_CLAUDE_OPUS_55,
  PRICING_OR_CLAUDE_SONNET_55,
  PRICING_OR_DEEPSEEK_V41_FLASH,
  PRICING_OR_GENERIC,
  PRICING_OR_GPT_4O_MINI,
  PRICING_OR_GPT_61_SOL,
  PRICING_OR_GROK_47,
  PRICING_OR_KIMI_K31_PRO,
} from "./pricing.ts"

/**
 * Token estimator for OpenRouter. OpenRouter proxies many upstream models
 * (OpenAI, Anthropic, others) on the OpenAI Chat wire, so no single
 * tokenizer applies. ~3.8 chars/token splits the difference between the
 * Anthropic (~3.5) and OpenAI (~4) families for a defensible estimate.
 */
const estimateOpenRouterTokens = makeCharRatioEstimator(3.8)

/** Local catalog of id + tags for scout/balanced picks by tag. */
const localCatalog: Array<{ id: string; tags: readonly string[] }> = []

/** First registered model whose tags include every entry in `mustHave`. */
export function findOpenRouterModelByTags(mustHave: readonly string[]): string | undefined {
  return localCatalog.find((m) => mustHave.every((t) => m.tags.includes(t)))?.id
}

/**
 * Populate the registry with a representative OpenRouter catalog through the
 * setup-context registrar (the `models:register` capability). Taking the
 * registrar as a parameter (rather than importing the global `registerModel`
 * from `src/`) is what lets this provider live in its own repo.
 */
export function registerOpenRouterModels(models: ModelRegistrar): string[] {
  localCatalog.length = 0
  const ids: string[] = []
  const add = (spec: OpenRouterModelSpec): void => {
    ids.push(registerOpenRouterModelInto(models, spec))
  }

  // Flagship: large context, vision, reasoning, tools. (live 2026-11-15)
  add({
    id: "moonshotai/kimi-k3.1-pro",
    displayName: "Kimi K3.1 Pro (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "flagship"],
    capabilities: CAPS_OR_KIMI_K31_PRO,
    pricing: PRICING_OR_KIMI_K31_PRO,
  })
  // Cheap scout / high-volume candidate.
  add({
    id: "deepseek/deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "cheap"],
    capabilities: CAPS_OR_DEEPSEEK_V41_FLASH,
    pricing: PRICING_OR_DEEPSEEK_V41_FLASH,
  })
  // Balanced modern Anthropic.
  add({
    id: "anthropic/claude-sonnet-5.5",
    displayName: "Claude Sonnet 5.5 (OpenRouter)",
    tags: ["openrouter", "openai-compatible"],
    capabilities: CAPS_OR_CLAUDE_SONNET_55,
    pricing: PRICING_OR_CLAUDE_SONNET_55,
  })
  // Anthropic frontier via OpenRouter.
  add({
    id: "anthropic/claude-opus-5.5",
    displayName: "Claude Opus 5.5 (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "flagship"],
    capabilities: CAPS_OR_CLAUDE_OPUS_55,
    pricing: PRICING_OR_CLAUDE_OPUS_55,
  })
  // OpenAI frontier via OpenRouter.
  add({
    id: "openai/gpt-6.1-sol",
    displayName: "GPT-6.1 Sol (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "flagship"],
    capabilities: CAPS_OR_GPT_61_SOL,
    pricing: PRICING_OR_GPT_61_SOL,
  })
  // xAI frontier via OpenRouter.
  add({
    id: "x-ai/grok-4.7",
    displayName: "Grok 4.7 (OpenRouter)",
    tags: ["openrouter", "openai-compatible"],
    capabilities: CAPS_OR_GROK_47,
    pricing: PRICING_OR_GROK_47,
  })
  // Kept for live tests + a second cheap option.
  add({
    id: "openai/gpt-4o-mini",
    displayName: "GPT-4o mini (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "cheap"],
    capabilities: CAPS_OR_GPT_4O_MINI,
    pricing: PRICING_OR_GPT_4O_MINI,
  })
  return ids
}

export interface OpenRouterModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  capabilities?: Capabilities
  pricing?: MTokRate
}

/**
 * Register a single OpenRouter slug into the given registrar. Used for the
 * built-in catalog and for ad-hoc upstream slugs the static snapshot does not
 * know yet.
 */
export function registerOpenRouterModelInto(
  models: ModelRegistrar,
  spec: OpenRouterModelSpec,
): string {
  const tags = spec.tags ?? ["openrouter", "openai-compatible"]
  models.register({
    id: spec.id,
    providerId: "openrouter",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? spec.id,
    tags,
    capabilities: spec.capabilities ?? CAPS_OPENROUTER_CHAT,
    estimateTokens: estimateOpenRouterTokens,
    pricing: spec.pricing ?? PRICING_OR_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  localCatalog.push({ id: spec.id, tags })
  return spec.id
}
