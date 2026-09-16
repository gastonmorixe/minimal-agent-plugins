/**
 * DeepSeek model registry entries.
 *
 * DeepSeek's OpenAI-compatible surface uses two wire model ids (`deepseek-flash`
 * and `deepseek-v4-pro`). `deepseek-flash` is the slug DeepSeek currently serves
 * DeepSeek-V4.1-Flash under; the retired `deepseek-v4-flash` /
 * `deepseek-v4-flash-vision-exp` names are still accepted and billed as Flash,
 * so they are registered as aliases of the same entry.
 *
 * Any other slug still works on the wire (the CLI doesn't gate on the registry);
 * `registerDeepSeekModelInto` registers an ad-hoc entry with the fallback
 * capabilities when the host asks for one.
 *
 * @module llm/providers/deepseek/models
 */

import { CAPS_DEEPSEEK_CHAT, CAPS_DEEPSEEK_FLASH, CAPS_DEEPSEEK_V4_PRO } from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { MTokRate } from "./lib/host-types.ts"
import type { ModelRegistrar } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_DEEPSEEK_FLASH,
  PRICING_DEEPSEEK_GENERIC,
  PRICING_DEEPSEEK_V4_PRO,
} from "./pricing.ts"

export const DEEPSEEK_PROVIDER_ID = "deepseek"
export const DEEPSEEK_SURFACE_ID = "openai-chat-completions"

/**
 * Token estimator for DeepSeek. DeepSeek ships its own tokenizer, but its
 * ratio for mixed prose/code sits near the OpenAI family (~4 chars/token); 3.7
 * biases slightly conservative. Estimates only feed offline listings.
 */
const estimateDeepSeekTokens = makeCharRatioEstimator(3.7)

/** Local catalog of id + tags for tag-based picks. */
const localCatalog: Array<{ id: string; tags: readonly string[] }> = []

/** First registered model whose tags include every entry in `mustHave`. */
export function findDeepSeekModelByTags(mustHave: readonly string[]): string | undefined {
  return localCatalog.find((m) => mustHave.every((t) => m.tags.includes(t)))?.id
}

export interface DeepSeekModelSpec {
  id: string
  aliases?: string[]
  displayName?: string
  tags?: string[]
  capabilities?: Capabilities
  pricing?: MTokRate
}

/**
 * Register a single DeepSeek model into the given registrar. Used for the
 * built-in catalog and for ad-hoc wire slugs the static snapshot does not know.
 *
 * @param models - Host model registrar (the `models:register` capability).
 * @param spec - Model id plus optional metadata overrides.
 * @returns The registered model id.
 */
export function registerDeepSeekModelInto(models: ModelRegistrar, spec: DeepSeekModelSpec): string {
  const tags = spec.tags ?? [DEEPSEEK_PROVIDER_ID, "openai-compatible"]
  models.register({
    id: spec.id,
    ...(spec.aliases ? { aliases: spec.aliases } : {}),
    providerId: DEEPSEEK_PROVIDER_ID,
    surfaceId: DEEPSEEK_SURFACE_ID,
    displayName: spec.displayName ?? spec.id,
    tags,
    capabilities: spec.capabilities ?? CAPS_DEEPSEEK_CHAT,
    estimateTokens: estimateDeepSeekTokens,
    pricing: spec.pricing ?? PRICING_DEEPSEEK_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  localCatalog.push({ id: spec.id, tags })
  return spec.id
}

/**
 * Populate the registry with the DeepSeek catalog through the setup-context
 * registrar (the `models:register` capability), so this provider stays
 * self-contained (no `src/` import).
 *
 * @param models - Host model registrar.
 * @returns The registered model ids.
 */
export function registerDeepSeekModels(models: ModelRegistrar): string[] {
  localCatalog.length = 0
  const ids: string[] = []
  const add = (spec: DeepSeekModelSpec): void => {
    ids.push(registerDeepSeekModelInto(models, spec))
  }

  // DeepSeek-V4.1-Flash (vision). Legacy names alias to the same wire slug.
  add({
    id: "deepseek-flash",
    aliases: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    displayName: "DeepSeek V4.1 Flash",
    tags: [DEEPSEEK_PROVIDER_ID, "openai-compatible", "deepseek", "cheap", "vision"],
    capabilities: CAPS_DEEPSEEK_FLASH,
    pricing: PRICING_DEEPSEEK_FLASH,
  })
  // DeepSeek-V4-Pro (text-only).
  add({
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    tags: [DEEPSEEK_PROVIDER_ID, "openai-compatible", "deepseek", "flagship"],
    capabilities: CAPS_DEEPSEEK_V4_PRO,
    pricing: PRICING_DEEPSEEK_V4_PRO,
  })
  return ids
}
