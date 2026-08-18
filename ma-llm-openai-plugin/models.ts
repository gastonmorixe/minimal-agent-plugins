/**
 * OpenAI model registry entries.
 *
 * Mirrors the public OpenAI API catalog (refreshed 2026-07-30, Codex live
 * reconfirmed 2026-08-18 via `openai-chatgpt-oauth-3`) for the GPT-5.6
 * family plus established gpt-5.5 / gpt-5.4 / gpt-4o / o-series tables in
 * `capabilities.ts` and `pricing.ts`.
 *
 * Dual-surface models (reachable on BOTH Chat Completions and the Responses
 * API) are registered TWICE, under distinct ids with different `surfaceId`s.
 * `vendorIds.firstParty` always carries the REAL OpenAI model id sent on the
 * wire, so the `-chat` entry resolves to the same upstream model. The short
 * `gpt-5.6` alias resolves to `gpt-5.6-sol`, matching the public docs.
 * Pro SKUs (`gpt-5.5-pro`, `gpt-5.4-pro`) are Responses-only.
 *
 * ## ChatGPT OAuth consumer catalog ↔ API ids (2026-08-18)
 *
 * Live ChatGPT backend (`chatgpt.com/backend-api/models`) uses hyphenated
 * consumer slugs and Instant/Thinking/Pro *lanes*. Codex
 * (`chatgpt.com/backend-api/codex/models`) lists API slugs. This plugin
 * registers **API** model ids only (same ids are sent on ChatGPT-Codex
 * OAuth Responses traffic). Do not register consumer-only slugs here.
 *
 * Codex listed (this account): `gpt-5.6-sol` / `terra` / `luna`, `gpt-5.5`,
 * `gpt-5.4`, `gpt-5.4-mini` (Fast only on sol/terra/luna/5.5/5.4 — not mini).
 * `gpt-5.3-codex-spark` is listed but `supported_in_api: false`. Hidden
 * `codex-auto-review` is not a user model. Codex marks gpt-5.4 / 5.4-mini
 * for retirement 2026-08-31 (upgrade terra / luna).
 *
 * | ChatGPT slug (live) | API id / behavior |
 * | ------------------- | ----------------- |
 * | `gpt-5-5`, `gpt-5-5-instant`, `gpt-5-5-thinking` | `gpt-5.5` (lanes are UI; Instant ≈ low/no think, Thinking ≈ reasoning effort) |
 * | `gpt-5.5-wm` | `gpt-5.5` (ChatGPT Work Mode wrapper) |
 * | `gpt-5-5-pro` | `gpt-5.5-pro` |
 * | `gpt-5-6`, `gpt-5-6-instant`, `gpt-5-6-thinking` | `gpt-5.6-sol` (short alias `gpt-5.6`) |
 * | `gpt-5.6-sol-wm` / `terra-wm` / `luna-wm` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` |
 * | `gpt-5-6-mini`, `gpt-5-6-t-mini` | `gpt-5.6-luna` (consumer mini titles Luna) |
 * | `gpt-5-6-pro` | **no** `gpt-5.6-pro` API SKU (docs 404). Use `gpt-5.6-sol` (etc.) with Responses `reasoning.mode: "pro"` — not wired in caps yet |
 * | `gpt-5-3-mini`, `gpt-5-5-mini` | **TODO:** no public API counterpart in models catalog |
 * | `o3` | `o3` |
 * | `research` | Deep Research product surface — **TODO:** not an API chat/completions model id |
 *
 * ChatGPT `max_tokens` is a **consumer UI budget**, not the API
 * `contextWindow` (e.g. Thinking/Pro often advertise 410000 / 262144 while
 * API gpt-5.5 / gpt-5.6-sol remain 1_050_000). Never overwrite caps from it.
 *
 * ChatGPT thinking efforts are consumer labels
 * `min|standard|extended|max` (Pro often `standard|extended` only). API
 * effort ladders stay on developers.openai.com vocabulary
 * (`none|minimal|low|medium|high|xhigh|max` per model) — do not substitute.
 *
 * @module llm/providers/openai/models
 */

import {
  CAPS_GPT_4O_CHAT,
  CAPS_GPT_4O_MINI_CHAT,
  CAPS_GPT_5_4_CHAT,
  CAPS_GPT_5_4_MINI_CHAT,
  CAPS_GPT_5_4_MINI_RESPONSES,
  CAPS_GPT_5_4_NANO_CHAT,
  CAPS_GPT_5_4_NANO_RESPONSES,
  CAPS_GPT_5_4_PRO_RESPONSES,
  CAPS_GPT_5_4_RESPONSES,
  CAPS_GPT_5_5_CHAT,
  CAPS_GPT_5_5_PRO_RESPONSES,
  CAPS_GPT_5_5_RESPONSES,
  CAPS_GPT_5_6_LUNA_CHAT,
  CAPS_GPT_5_6_LUNA_RESPONSES,
  CAPS_GPT_5_6_SOL_CHAT,
  CAPS_GPT_5_6_SOL_RESPONSES,
  CAPS_GPT_5_6_TERRA_CHAT,
  CAPS_GPT_5_6_TERRA_RESPONSES,
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
  PRICING_GPT_5_4,
  PRICING_GPT_5_4_MINI,
  PRICING_GPT_5_4_NANO,
  PRICING_GPT_5_4_PRO,
  PRICING_GPT_5_5,
  PRICING_GPT_5_5_PRO,
  PRICING_GPT_5_6_LUNA,
  PRICING_GPT_5_6_SOL,
  PRICING_GPT_5_6_TERRA,
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
  const ids: string[] = []
  const register = (spec: ProviderModelSpec): void => {
    registrar.register(spec)
    localCatalog.push({ id: spec.id, tags: spec.tags ?? [] })
    ids.push(spec.id)
  }

  // GPT-5.6 family. Responses is preferred; the `-chat` ids target Chat
  // Completions. The short `gpt-5.6` alias routes to Sol.
  // ChatGPT live (2026-08-18): `gpt-5-6` / instant / thinking / sol-wm → sol;
  // `gpt-5-6-pro` is consumer Pro lane (API: reasoning.mode=pro, not a SKU).
  register({
    id: "gpt-5.6-sol",
    aliases: ["gpt-5.6"],
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.6 Sol",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "flagship", "reasoning", "production"],
    capabilities: CAPS_GPT_5_6_SOL_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_6_SOL,
    vendorIds: { firstParty: "gpt-5.6-sol" },
  })
  register({
    id: "gpt-5.6-sol-chat",
    aliases: ["gpt-5.6-chat"],
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.6 Sol (Chat Completions)",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "flagship", "chat"],
    capabilities: CAPS_GPT_5_6_SOL_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_6_SOL,
    vendorIds: { firstParty: "gpt-5.6-sol" },
  })
  register({
    id: "gpt-5.6-terra",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.6 Terra",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "balanced", "reasoning", "production"],
    capabilities: CAPS_GPT_5_6_TERRA_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_6_TERRA,
    vendorIds: { firstParty: "gpt-5.6-terra" },
  })
  register({
    id: "gpt-5.6-terra-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.6 Terra (Chat Completions)",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "balanced", "chat"],
    capabilities: CAPS_GPT_5_6_TERRA_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_6_TERRA,
    vendorIds: { firstParty: "gpt-5.6-terra" },
  })
  register({
    id: "gpt-5.6-luna",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.6 Luna",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "reasoning", "fast", "cheap"],
    capabilities: CAPS_GPT_5_6_LUNA_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_6_LUNA,
    vendorIds: { firstParty: "gpt-5.6-luna" },
  })
  register({
    id: "gpt-5.6-luna-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.6 Luna (Chat Completions)",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "chat", "fast", "cheap"],
    capabilities: CAPS_GPT_5_6_LUNA_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_6_LUNA,
    vendorIds: { firstParty: "gpt-5.6-luna" },
  })

  // GPT-5.5 generation.
  // ChatGPT live (2026-07-30): default slug `gpt-5-5`; Instant/Thinking/Pro
  // lanes → `gpt-5-5-instant` / `gpt-5-5-thinking` / `gpt-5-5-pro` (API
  // `gpt-5.5` / `gpt-5.5-pro`). Consumer max_tokens often 137k–410k UI limits.
  register({
    id: "gpt-5.5-pro",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.5 Pro",
    knowledgeCutoff: "2025-12-01",
    tags: ["gpt-5", "pro", "reasoning"],
    capabilities: CAPS_GPT_5_5_PRO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_5_PRO,
    vendorIds: { firstParty: "gpt-5.5-pro" },
  })
  register({
    id: "gpt-5.5",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.5",
    knowledgeCutoff: "2025-12-01",
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
    knowledgeCutoff: "2025-12-01",
    tags: ["gpt-5", "flagship", "chat"],
    capabilities: CAPS_GPT_5_5_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_5,
    vendorIds: { firstParty: "gpt-5.5" },
  })

  // GPT-5.4 generation.
  register({
    id: "gpt-5.4-pro",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.4 Pro",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "pro", "reasoning"],
    capabilities: CAPS_GPT_5_4_PRO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4_PRO,
    vendorIds: { firstParty: "gpt-5.4-pro" },
  })
  register({
    id: "gpt-5.4",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.4",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "reasoning", "production"],
    capabilities: CAPS_GPT_5_4_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4,
    vendorIds: { firstParty: "gpt-5.4" },
  })
  register({
    id: "gpt-5.4-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.4 (Chat Completions)",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "chat"],
    capabilities: CAPS_GPT_5_4_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4,
    vendorIds: { firstParty: "gpt-5.4" },
  })
  register({
    id: "gpt-5.4-mini",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.4 mini",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "reasoning", "fast"],
    capabilities: CAPS_GPT_5_4_MINI_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4_MINI,
    vendorIds: { firstParty: "gpt-5.4-mini" },
  })
  register({
    id: "gpt-5.4-mini-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.4 mini (Chat Completions)",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "chat", "fast"],
    capabilities: CAPS_GPT_5_4_MINI_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4_MINI,
    vendorIds: { firstParty: "gpt-5.4-mini" },
  })
  register({
    id: "gpt-5.4-nano",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.4 nano",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "reasoning", "fast", "cheap"],
    capabilities: CAPS_GPT_5_4_NANO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4_NANO,
    vendorIds: { firstParty: "gpt-5.4-nano" },
  })
  register({
    id: "gpt-5.4-nano-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.4 nano (Chat Completions)",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "chat", "fast", "cheap"],
    capabilities: CAPS_GPT_5_4_NANO_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_4_NANO,
    vendorIds: { firstParty: "gpt-5.4-nano" },
  })

  // GPT-5 legacy Responses surface.
  register({
    id: "gpt-5",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5",
    knowledgeCutoff: "2024-09-30",
    tags: ["gpt-5", "reasoning"],
    capabilities: CAPS_GPT_5_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5,
    vendorIds: { firstParty: "gpt-5" },
  })

  // o-series reasoning models (Responses surface, visible reasoning).
  // ChatGPT live (2026-07-30): still lists `o3` under Legacy models.
  register({
    id: "o3",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o3",
    knowledgeCutoff: "2024-06-01",
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
    knowledgeCutoff: "2024-06-01",
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
    knowledgeCutoff: "2024-06-01",
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
    knowledgeCutoff: "2023-10-01",
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
    knowledgeCutoff: "2023-10-01",
    tags: ["gpt-4", "chat", "fast", "cheap"],
    capabilities: CAPS_GPT_4O_MINI_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_4O_MINI,
    vendorIds: { firstParty: "gpt-4o-mini" },
  })

  return ids
}
