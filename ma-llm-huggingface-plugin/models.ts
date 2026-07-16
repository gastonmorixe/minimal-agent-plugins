/**
 * HuggingFace model registry entries.
 *
 * HuggingFace Inference Providers uses namespaced model ids
 * (`openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Flash`, etc.) with an
 * optional `:provider` suffix for backend selection. All register on
 * the `openai-chat-completions` surface — HuggingFace normalizes every
 * upstream model to the OpenAI Chat Completions wire format.
 *
 * A representative few are registered; any other HuggingFace model id
 * still works on the wire (the CLI doesn't gate on the registry), just
 * without a local cost estimate.
 *
 * @module llm/providers/huggingface/models
 */

import { CAPS_HUGGINGFACE_CHAT } from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { ModelRegistrar } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_HF_DEEPSEEK_V4_FLASH,
  PRICING_HF_GENERIC,
  PRICING_HF_GLM_5_2,
  PRICING_HF_GPT_OSS_120B,
  PRICING_HF_KIMI_K2_7_CODE,
  PRICING_HF_MINIMAX_M3,
} from "./pricing.ts"

/**
 * Token estimator for HuggingFace. HuggingFace proxies many upstream
 * models on the OpenAI Chat wire, so no single tokenizer applies.
 * ~3.8 chars/token splits the difference between Anthropic (~3.5) and
 * OpenAI (~4) families.
 */
const estimateHuggingFaceTokens = makeCharRatioEstimator(3.8)

/**
 * Local catalog of id-to-tags captured at registration, so the adapter's
 * `recommendSubagentModels` can pick scout/balanced models from THIS
 * provider's own catalog by tag without a host-registry round-trip (the old
 * `findModelByTags` from `src/`). Populated by `registerHuggingFaceModelInto`.
 */
const localCatalog = new Map<string, readonly string[]>()

/**
 * Populate the canonical model registry with the HuggingFace catalog through
 * the setup-context registrar (the `models:register` capability). Taking the
 * registrar as a parameter (rather than importing the global `registerModel`
 * from `src/`) is what lets this provider live in its own repo. Idempotent
 * (last-write-wins). Returns the registered ids for tests.
 *
 * @param registrar - Host model registrar (the `models:register` capability).
 * @returns The registered model ids.
 */
export function registerHuggingFaceModels(registrar: ModelRegistrar): string[] {
  // deepseek-ai/DeepSeek-V4-Flash: cheap / scout tier
  registerHuggingFaceModelInto(registrar, {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    displayName: "DeepSeek V4 Flash (HuggingFace)",
    tags: ["huggingface", "openai-compatible", "cheap"],
    pricing: PRICING_HF_DEEPSEEK_V4_FLASH,
  })
  // moonshotai/Kimi-K2.7-Code: reasoning / code
  registerHuggingFaceModelInto(registrar, {
    id: "moonshotai/Kimi-K2.7-Code",
    displayName: "Kimi K2.7 Code (HuggingFace)",
    tags: ["huggingface", "openai-compatible", "reasoning", "code"],
    pricing: PRICING_HF_KIMI_K2_7_CODE,
  })
  // zai-org/GLM-5.2: flagship / reasoning
  registerHuggingFaceModelInto(registrar, {
    id: "zai-org/GLM-5.2",
    displayName: "GLM 5.2 (HuggingFace)",
    tags: ["huggingface", "openai-compatible", "flagship", "reasoning"],
    pricing: PRICING_HF_GLM_5_2,
  })
  // openai/gpt-oss-120b: open-weights reference model
  registerHuggingFaceModelInto(registrar, {
    id: "openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B (HuggingFace)",
    tags: ["huggingface", "openai-compatible"],
    pricing: PRICING_HF_GPT_OSS_120B,
  })
  // MiniMaxAI/MiniMax-M3
  registerHuggingFaceModelInto(registrar, {
    id: "MiniMaxAI/MiniMax-M3",
    displayName: "MiniMax M3 (HuggingFace)",
    tags: ["huggingface", "openai-compatible"],
    pricing: PRICING_HF_MINIMAX_M3,
  })

  return [
    "deepseek-ai/DeepSeek-V4-Flash",
    "moonshotai/Kimi-K2.7-Code",
    "zai-org/GLM-5.2",
    "openai/gpt-oss-120b",
    "MiniMaxAI/MiniMax-M3",
  ]
}

export interface HuggingFaceModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  pricing?: typeof PRICING_HF_GENERIC
  /**
   * Per-model capabilities. Defaults to the permissive
   * {@link CAPS_HUGGINGFACE_CHAT}; pass caps derived from the live
   * `/v1/models` entry (via `deriveHuggingFaceCapabilities`) to narrow tools /
   * structured outputs / context window / image modality to what the model's
   * backends actually offer.
   */
  capabilities?: Capabilities
}

/**
 * Register a single HuggingFace slug into the given registrar. Used for the
 * built-in catalog and for ad-hoc upstream slugs the static snapshot does not
 * know yet. Also records the model's tags in the local catalog so
 * `findHuggingFaceModelByTags` can resolve sub-agent role picks locally.
 */
export function registerHuggingFaceModelInto(
  registrar: ModelRegistrar,
  spec: HuggingFaceModelSpec,
): string {
  const tags = spec.tags ?? ["huggingface", "openai-compatible"]
  registrar.register({
    id: spec.id,
    providerId: "huggingface",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? spec.id,
    tags,
    capabilities: spec.capabilities ?? CAPS_HUGGINGFACE_CHAT,
    estimateTokens: estimateHuggingFaceTokens,
    pricing: spec.pricing ?? PRICING_HF_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  localCatalog.set(spec.id, tags)
  return spec.id
}

/**
 * Find a registered HuggingFace model id whose tags include every tag in
 * `mustHave`, reading THIS provider's local catalog (no host-registry read).
 * Returns the first matching id, or undefined.
 */
export function findHuggingFaceModelByTags(mustHave: readonly string[]): string | undefined {
  for (const [id, tags] of localCatalog) {
    if (mustHave.every((t) => tags.includes(t))) return id
  }
  return undefined
}
