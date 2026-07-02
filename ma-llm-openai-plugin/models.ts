/**
 * OpenAI model registry entries.
 *
 * Mirrors the codex `models.json` flagship catalog (the gpt-5.x family,
 * led by `gpt-5.5`) plus the established gpt-4o / o-series on their
 * capability tables in `capabilities.ts`.
 *
 * Dual-surface models (reachable on BOTH Chat Completions and the
 * Responses API) are registered TWICE, under distinct ids with different
 * `surfaceId`s. `vendorIds.firstParty` always carries the REAL OpenAI
 * model id sent on the wire, so the `-chat` alias resolves to the same
 * upstream model. `adapter.run()` dispatches by `surfaceId`.
 *
 * @module llm/providers/openai/models
 */

import {
  CAPS_GPT_4O_CHAT,
  CAPS_GPT_4O_MINI_CHAT,
  CAPS_GPT_5_5_CHAT,
  CAPS_GPT_5_5_RESPONSES,
  CAPS_GPT_5_RESPONSES,
  CAPS_GPT_41_CHAT,
  CAPS_O3_RESPONSES,
  CAPS_O4_MINI_RESPONSES,
} from "./capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_GPT_4O,
  PRICING_GPT_4O_MINI,
  PRICING_GPT_5,
  PRICING_GPT_5_5,
  PRICING_GPT_41,
  PRICING_O3,
  PRICING_O4_MINI,
} from "./pricing.ts"

/**
 * Token estimator for OpenAI's tokenizer families (cl100k / o200k). ~4
 * chars/token is the well-known rule of thumb for English text on these
 * encoders. Shared by every OpenAI model entry.
 */
const estimateOpenAITokens = makeCharRatioEstimator(4)

/**
 * Populate the canonical model registry with the OpenAI catalog.
 * Idempotent (last-write-wins). Returns the registered ids for tests.
 *
 * Registry seam (Wave D): when the host passes a {@link ModelRegistrar} (the
 * `models:register` capability, threaded through `register(ctx)`), the catalog
 * is contributed through `ctx.models.register` — no `src/` import needed. When
 * no registrar is supplied (the legacy no-arg activation path, or a direct call
 * in a test), it falls back to the imported `registerModel`. This lets the live
 * provider-loader adopt the ctx-driven path provider-by-provider without
 * breaking the no-context callers.
 *
 * @param registrar - Optional host model registrar; defaults to the direct import.
 * @returns The registered model ids.
 */
/**
 * Local catalog of id + tags captured at registration, so the adapter's
 * `recommendSubagentModels` can pick scout/balanced/deep models from THIS
 * provider's own catalog by tag, without a host registry read
 * (`findModelByTags`). A moved plugin can't reach host registry state, and it
 * doesn't need to: it knows its own catalog because it just registered it.
 */
const localCatalog: Array<{ id: string; tags: readonly string[] }> = []

/** Find the first registered model whose tags include all of `mustHave`. */
export function findOpenAIModelByTags(mustHave: readonly string[]): string | undefined {
  return localCatalog.find((m) => mustHave.every((t) => m.tags.includes(t)))?.id
}

/**
 * Register the full OpenAI catalog through the setup-context registrar (the
 * `models:register` capability). As a moved plugin this always runs with a
 * real registrar handed in at `register(ctx)`; there is no host-registry
 * fallback import. Returns the registered model ids.
 */
export function registerOpenAIModels(registrar: ModelRegistrar): string[] {
  localCatalog.length = 0
  const register = (spec: ProviderModelSpec): void => {
    registrar.register(spec)
    localCatalog.push({ id: spec.id, tags: spec.tags ?? [] })
  }
  // GPT-5.5 — flagship. Responses is the preferred surface; the `-chat`
  // id targets Chat Completions. Both send model id "gpt-5.5".
  register({
    id: "gpt-5.5",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.5",
    knowledgeCutoff: "2025-12",
    tags: ["gpt-5", "flagship", "reasoning", "production"],
    capabilities: CAPS_GPT_5_5_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_5,
    vendorIds: { firstParty: "gpt-5.5" },
  })
  register({
    id: "gpt-5.5-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.5 (Chat Completions)",
    knowledgeCutoff: "2025-12",
    tags: ["gpt-5", "flagship", "chat"],
    capabilities: CAPS_GPT_5_5_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_5,
    vendorIds: { firstParty: "gpt-5.5" },
  })

  // GPT-5 (Responses surface).
  register({
    id: "gpt-5",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5",
    tags: ["gpt-5", "reasoning"],
    capabilities: CAPS_GPT_5_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5,
    vendorIds: { firstParty: "gpt-5" },
  })

  // o-series reasoning models (Responses surface, visible reasoning).
  register({
    id: "o3",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o3",
    tags: ["o-series", "reasoning"],
    capabilities: CAPS_O3_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O3,
    vendorIds: { firstParty: "o3" },
  })
  register({
    id: "o4-mini",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o4-mini",
    tags: ["o-series", "reasoning", "fast"],
    capabilities: CAPS_O4_MINI_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O4_MINI,
    vendorIds: { firstParty: "o4-mini" },
  })

  // gpt-4 family (Chat Completions surface).
  register({
    id: "gpt-4.1",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4.1",
    tags: ["gpt-4", "chat", "long-context"],
    capabilities: CAPS_GPT_41_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_41,
    vendorIds: { firstParty: "gpt-4.1" },
  })
  register({
    id: "gpt-4o",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4o",
    tags: ["gpt-4", "chat", "multimodal"],
    capabilities: CAPS_GPT_4O_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_4O,
    vendorIds: { firstParty: "gpt-4o" },
  })
  register({
    id: "gpt-4o-mini",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4o mini",
    tags: ["gpt-4", "chat", "fast", "cheap"],
    capabilities: CAPS_GPT_4O_MINI_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_4O_MINI,
    vendorIds: { firstParty: "gpt-4o-mini" },
  })

  return ["gpt-5.5", "gpt-5.5-chat", "gpt-5", "o3", "o4-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
}
