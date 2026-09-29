/**
 * OpenAI model registry entries.
 *
 * Mirrors the public OpenAI API catalog (refreshed 2026-09-08 via Codex live
 * `openai-chatgpt-oauth-4` + developers.openai.com, GPT-6.1 Sol / GPT-6 Sol /
 * GPT-6 Luna added 2026-09-29 from the model cards) for GPT-6 Astra, the
 * GPT-5.6 family, plus established gpt-5.5 / gpt-5.4 / gpt-4o / o-series
 * tables in `capabilities.ts` and `pricing.ts`.
 *
 * Dual-surface models (reachable on BOTH Chat Completions and the Responses
 * API) are registered TWICE, under distinct ids with different `surfaceId`s.
 * `vendorIds.firstParty` always carries the REAL OpenAI model id sent on the
 * wire, so the `-chat` entry resolves to the same upstream model. The short
 * `gpt-5.6` alias resolves to `gpt-5.6-sol`, matching the public docs.
 * Pro SKUs (`gpt-5.5-pro`, `gpt-5.4-pro`) are Responses-only.
 *
 * ## ChatGPT OAuth consumer catalog ↔ API ids (2026-09-08)
 *
 * Live ChatGPT backend (`chatgpt.com/backend-api/models`) uses hyphenated
 * consumer slugs and Instant/Thinking/Pro *lanes*. Codex
 * (`chatgpt.com/backend-api/codex/models?client_version=1.0.0`) lists API
 * slugs. This plugin registers **API** model ids only (same ids are sent on
 * ChatGPT-Codex OAuth Responses traffic). Do not register consumer-only
 * slugs here.
 *
 * Codex listed (plus plan, this account): `gpt-6-astra` (priority 1, Fast
 * 2x), hidden `gpt-reserve`, `gpt-5.6-sol` / `terra` / `luna`, `gpt-5.5`,
 * hidden `codex-auto-review`. gpt-5.4 family is gone from Codex (retired
 * 2026-08-31) but kept in this registry for API-key compatibility.
 *
 * | ChatGPT slug (live) | API id / behavior |
 * | ------------------- | ----------------- |
 * | `gpt-6-astra-wm` | `gpt-6-astra` (Work Mode wrapper; flagship) |
 * | `gpt-5-5`, `gpt-5-5-instant`, `gpt-5-5-thinking` | `gpt-5.5` (lanes are UI; Instant ≈ low/no think, Thinking ≈ reasoning effort) |
 * | `gpt-5.5-wm` | `gpt-5.5` (ChatGPT Work Mode wrapper) |
 * | `gpt-5-5-pro` | `gpt-5.5-pro` |
 * | `gpt-5-6`, `gpt-5-6-instant`, `gpt-5-6-thinking` | `gpt-5.6-sol` (short alias `gpt-5.6`) |
 * | `gpt-5.6-sol-wm` / `terra-wm` / `luna-wm` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` |
 * | `gpt-5-6-mini`, `gpt-5-6-t-mini` | `gpt-5.6-luna` (consumer mini titles Luna) |
 * | `gpt-reserve` | Codex/ChatGPT hidden reserve lane — **not** registered |
 * | `gpt-5-6-pro` | **no** `gpt-5.6-pro` API SKU (docs 404). Use `gpt-5.6-sol` (etc.) with Responses `reasoning.mode: "pro"` — not wired in caps yet |
 * | `gpt-5-3-mini`, `gpt-5-5-mini` | **TODO:** no public API counterpart in models catalog |
 * | `o3` | `o3` |
 * | `chat-latest` | moving alias to the ChatGPT Instant model (effort `medium` only) |
 * | `gpt-5.1`, `gpt-5.2`, `gpt-5-mini`, `gpt-5-nano` | same ids, Responses + `-chat` (registered 2026-09-29) |
 * | `gpt-5.2-pro`, `gpt-5.3-codex`, `gpt-5-pro`, `o1-pro`, `o3-pro` | same ids, Responses only |
 * | `o1`, `o3-mini`, `gpt-4.1-mini`, `gpt-4.1-nano` | same ids, both surfaces |
 * | `research` | Deep Research product surface — **TODO:** not an API chat/completions model id |
 *
 * ChatGPT `max_tokens` is a **consumer UI budget**, not the API
 * `contextWindow` (e.g. Thinking/Pro often advertise 410000 / 262144 while
 * API gpt-5.5 / gpt-5.6-sol / gpt-6-astra remain 1_050_000). Never overwrite
 * caps from it.
 *
 * ChatGPT thinking efforts are consumer labels
 * `min|standard|extended|max` (Pro often `standard|extended` only). API
 * effort ladders stay on developers.openai.com vocabulary
 * (`none|minimal|low|medium|high|xhigh|max` per model) — do not substitute.
 *
 * @module llm/providers/openai/models
 */

import {
  CAPS_CHAT_LATEST_CHAT,
  CAPS_CHAT_LATEST_RESPONSES,
  CAPS_GPT_4O_CHAT,
  CAPS_GPT_4O_MINI_CHAT,
  CAPS_GPT_5_1_CHAT,
  CAPS_GPT_5_1_RESPONSES,
  CAPS_GPT_5_2_CHAT,
  CAPS_GPT_5_2_PRO_RESPONSES,
  CAPS_GPT_5_2_RESPONSES,
  CAPS_GPT_5_3_CODEX_RESPONSES,
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
  CAPS_GPT_5_MINI_CHAT,
  CAPS_GPT_5_MINI_RESPONSES,
  CAPS_GPT_5_NANO_CHAT,
  CAPS_GPT_5_NANO_RESPONSES,
  CAPS_GPT_5_PRO_RESPONSES,
  CAPS_GPT_5_RESPONSES,
  CAPS_GPT_6_1_SOL_CHAT,
  CAPS_GPT_6_1_SOL_RESPONSES,
  CAPS_GPT_6_ASTRA_CHAT,
  CAPS_GPT_6_ASTRA_RESPONSES,
  CAPS_GPT_6_LUNA_CHAT,
  CAPS_GPT_6_LUNA_RESPONSES,
  CAPS_GPT_6_SOL_CHAT,
  CAPS_GPT_6_SOL_RESPONSES,
  CAPS_GPT_41_CHAT,
  CAPS_GPT_41_MINI_CHAT,
  CAPS_GPT_41_MINI_RESPONSES,
  CAPS_GPT_41_NANO_CHAT,
  CAPS_GPT_41_NANO_RESPONSES,
  CAPS_O1_CHAT,
  CAPS_O1_PRO_RESPONSES,
  CAPS_O1_RESPONSES,
  CAPS_O3_MINI_CHAT,
  CAPS_O3_MINI_RESPONSES,
  CAPS_O3_PRO_RESPONSES,
  CAPS_O3_RESPONSES,
  CAPS_O4_MINI_RESPONSES,
} from "./capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_CHAT_LATEST,
  PRICING_GPT_4O,
  PRICING_GPT_4O_MINI,
  PRICING_GPT_5,
  PRICING_GPT_5_1,
  PRICING_GPT_5_2,
  PRICING_GPT_5_2_PRO,
  PRICING_GPT_5_3_CODEX,
  PRICING_GPT_5_4,
  PRICING_GPT_5_4_MINI,
  PRICING_GPT_5_4_NANO,
  PRICING_GPT_5_4_PRO,
  PRICING_GPT_5_5,
  PRICING_GPT_5_5_PRO,
  PRICING_GPT_5_6_LUNA,
  PRICING_GPT_5_6_SOL,
  PRICING_GPT_5_6_TERRA,
  PRICING_GPT_5_MINI,
  PRICING_GPT_5_NANO,
  PRICING_GPT_5_PRO,
  PRICING_GPT_6_1_SOL,
  PRICING_GPT_6_ASTRA,
  PRICING_GPT_6_LUNA,
  PRICING_GPT_6_SOL,
  PRICING_GPT_41,
  PRICING_GPT_41_MINI,
  PRICING_GPT_41_NANO,
  PRICING_O1,
  PRICING_O1_PRO,
  PRICING_O3,
  PRICING_O3_MINI,
  PRICING_O3_PRO,
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

  // GPT-6 Astra (current flagship). Registered first so recommendSubagent
  // flagship tags resolve here. Dual surface (docs + Codex). ChatGPT
  // live (2026-09-08): work-mode slug `gpt-6-astra-wm` → astra.
  register({
    id: "gpt-6-astra",
    aliases: ["astra"],
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-6 Astra",
    knowledgeCutoff: "2026-04-30",
    tags: ["gpt-6", "flagship", "reasoning", "production"],
    capabilities: CAPS_GPT_6_ASTRA_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_ASTRA,
    vendorIds: { firstParty: "gpt-6-astra" },
  })
  register({
    id: "gpt-6-astra-chat",
    aliases: ["astra-chat"],
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-6 Astra (Chat Completions)",
    knowledgeCutoff: "2026-04-30",
    tags: ["gpt-6", "flagship", "chat"],
    capabilities: CAPS_GPT_6_ASTRA_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_ASTRA,
    vendorIds: { firstParty: "gpt-6-astra" },
  })

  // GPT-6.1 Sol (2026-09-29), GPT-6 Sol and GPT-6 Luna (2026-09-22).
  // Sourced from developers.openai.com model cards on 2026-09-29.
  register({
    id: "gpt-6.1-sol",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-6.1 Sol",
    knowledgeCutoff: "2026-04-30",
    tags: ["gpt-6", "balanced", "reasoning", "production"],
    capabilities: CAPS_GPT_6_1_SOL_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_1_SOL,
    vendorIds: { firstParty: "gpt-6.1-sol" },
  })
  register({
    id: "gpt-6.1-sol-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-6.1 Sol (Chat Completions)",
    knowledgeCutoff: "2026-04-30",
    tags: ["gpt-6", "balanced", "chat"],
    capabilities: CAPS_GPT_6_1_SOL_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_1_SOL,
    vendorIds: { firstParty: "gpt-6.1-sol" },
  })
  register({
    id: "gpt-6-sol",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-6 Sol",
    knowledgeCutoff: "2026-04-20",
    tags: ["gpt-6", "reasoning"],
    capabilities: CAPS_GPT_6_SOL_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_SOL,
    vendorIds: { firstParty: "gpt-6-sol" },
  })
  register({
    id: "gpt-6-sol-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-6 Sol (Chat Completions)",
    knowledgeCutoff: "2026-04-20",
    tags: ["gpt-6", "chat"],
    capabilities: CAPS_GPT_6_SOL_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_SOL,
    vendorIds: { firstParty: "gpt-6-sol" },
  })
  register({
    id: "gpt-6-luna",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-6 Luna",
    knowledgeCutoff: "2026-05-18",
    tags: ["gpt-6", "reasoning", "fast", "cheap"],
    capabilities: CAPS_GPT_6_LUNA_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_LUNA,
    vendorIds: { firstParty: "gpt-6-luna" },
  })
  register({
    id: "gpt-6-luna-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-6 Luna (Chat Completions)",
    knowledgeCutoff: "2026-05-18",
    // No "fast" tag on purpose: scout picks ["chat","fast"] and needs a chat
    // model that can call tools. Luna Chat tools work only with effort none.
    tags: ["gpt-6", "chat", "cheap"],
    capabilities: CAPS_GPT_6_LUNA_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_6_LUNA,
    vendorIds: { firstParty: "gpt-6-luna" },
  })

  // GPT-5.6 family. Responses is preferred; the `-chat` ids target Chat
  // Completions. The short `gpt-5.6` alias routes to Sol.
  // ChatGPT live (2026-09-08): `gpt-5-6` / instant / thinking / sol-wm → sol;
  // `gpt-5-6-pro` is consumer Pro lane (API: reasoning.mode=pro, not a SKU).
  register({
    id: "gpt-5.6-sol",
    aliases: ["gpt-5.6"],
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.6 Sol",
    knowledgeCutoff: "2026-02-16",
    tags: ["gpt-5", "reasoning", "production"],
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
    tags: ["gpt-5", "chat"],
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
    tags: ["gpt-5", "reasoning", "production"],
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
    tags: ["gpt-5", "chat"],
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

  // Remaining API models (2026-09-29, live probes with openai-api-key-2).
  // Responses entry id = wire id. A "-chat" sibling exists only where both
  // surfaces returned 200. Pro SKUs are Responses only.
  //
  // NOT registered on purpose (do not re-add). Removed with 404, no data, or
  // out of scope, checked 2026-09-29: gpt-5.1-chat-latest, gpt-5.1-codex,
  // gpt-5.1-codex-max, gpt-5.1-codex-mini, gpt-5.2-codex,
  // gpt-5.2-chat-latest, gpt-5.3-chat-latest, gpt-5-codex, gpt-5-chat-latest,
  // o3-deep-research, o4-mini-deep-research, gpt-5-search-api, gpt-4,
  // gpt-4-turbo, gpt-3.5-turbo.

  // GPT-5.1.
  register({
    id: "gpt-5.1",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.1",
    knowledgeCutoff: "2024-09-30",
    tags: ["gpt-5", "reasoning"],
    capabilities: CAPS_GPT_5_1_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_1,
    vendorIds: { firstParty: "gpt-5.1" },
  })
  register({
    id: "gpt-5.1-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.1 (Chat Completions)",
    knowledgeCutoff: "2024-09-30",
    tags: ["gpt-5", "chat"],
    capabilities: CAPS_GPT_5_1_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_1,
    vendorIds: { firstParty: "gpt-5.1" },
  })

  // GPT-5.2.
  register({
    id: "gpt-5.2",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.2",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "reasoning"],
    capabilities: CAPS_GPT_5_2_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_2,
    vendorIds: { firstParty: "gpt-5.2" },
  })
  register({
    id: "gpt-5.2-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5.2 (Chat Completions)",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "chat"],
    capabilities: CAPS_GPT_5_2_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_2,
    vendorIds: { firstParty: "gpt-5.2" },
  })

  // GPT-5.2 Pro.
  register({
    id: "gpt-5.2-pro",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.2 Pro",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "pro", "reasoning"],
    capabilities: CAPS_GPT_5_2_PRO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_2_PRO,
    vendorIds: { firstParty: "gpt-5.2-pro" },
  })

  // GPT-5.3-Codex.
  register({
    id: "gpt-5.3-codex",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.3-Codex",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "reasoning", "codex"],
    capabilities: CAPS_GPT_5_3_CODEX_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_3_CODEX,
    vendorIds: { firstParty: "gpt-5.3-codex" },
  })

  // Deprecated, shutdown 2026-12-11.
  register({
    id: "gpt-5-mini",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5 mini (deprecated 2026-12-11)",
    knowledgeCutoff: "2024-05-31",
    tags: ["gpt-5", "reasoning", "legacy"],
    capabilities: CAPS_GPT_5_MINI_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_MINI,
    vendorIds: { firstParty: "gpt-5-mini" },
  })
  register({
    id: "gpt-5-mini-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5 mini (Chat Completions) (deprecated 2026-12-11)",
    knowledgeCutoff: "2024-05-31",
    tags: ["gpt-5", "chat", "legacy"],
    capabilities: CAPS_GPT_5_MINI_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_MINI,
    vendorIds: { firstParty: "gpt-5-mini" },
  })

  // Deprecated, shutdown 2026-12-11.
  register({
    id: "gpt-5-nano",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5 nano (deprecated 2026-12-11)",
    knowledgeCutoff: "2024-05-31",
    tags: ["gpt-5", "reasoning", "legacy"],
    capabilities: CAPS_GPT_5_NANO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_NANO,
    vendorIds: { firstParty: "gpt-5-nano" },
  })
  register({
    id: "gpt-5-nano-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-5 nano (Chat Completions) (deprecated 2026-12-11)",
    knowledgeCutoff: "2024-05-31",
    tags: ["gpt-5", "chat", "legacy"],
    capabilities: CAPS_GPT_5_NANO_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_NANO,
    vendorIds: { firstParty: "gpt-5-nano" },
  })

  // Deprecated, shutdown 2026-12-11.
  register({
    id: "gpt-5-pro",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5 Pro (deprecated 2026-12-11)",
    knowledgeCutoff: "2024-09-30",
    tags: ["gpt-5", "pro", "reasoning", "legacy"],
    capabilities: CAPS_GPT_5_PRO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_5_PRO,
    vendorIds: { firstParty: "gpt-5-pro" },
  })

  // Chat Latest. Moving alias to the latest ChatGPT Instant model. The snapshot changes over time.
  register({
    id: "chat-latest",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "Chat Latest",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "reasoning", "alias"],
    capabilities: CAPS_CHAT_LATEST_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_CHAT_LATEST,
    vendorIds: { firstParty: "chat-latest" },
  })
  register({
    id: "chat-latest-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "Chat Latest (Chat Completions)",
    knowledgeCutoff: "2025-08-31",
    tags: ["gpt-5", "chat", "alias"],
    capabilities: CAPS_CHAT_LATEST_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_CHAT_LATEST,
    vendorIds: { firstParty: "chat-latest" },
  })

  // Deprecated, shutdown 2026-10-23.
  register({
    id: "o1",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o1 (deprecated 2026-10-23)",
    knowledgeCutoff: "2023-10-01",
    tags: ["o-series", "reasoning", "legacy"],
    capabilities: CAPS_O1_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O1,
    vendorIds: { firstParty: "o1" },
  })
  register({
    id: "o1-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "OpenAI o1 (Chat Completions) (deprecated 2026-10-23)",
    knowledgeCutoff: "2023-10-01",
    tags: ["o-series", "chat", "legacy"],
    capabilities: CAPS_O1_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O1,
    vendorIds: { firstParty: "o1" },
  })

  // Deprecated, shutdown 2026-10-23.
  register({
    id: "o1-pro",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o1-pro (deprecated 2026-10-23)",
    knowledgeCutoff: "2023-10-01",
    tags: ["o-series", "pro", "reasoning", "legacy"],
    capabilities: CAPS_O1_PRO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O1_PRO,
    vendorIds: { firstParty: "o1-pro" },
  })

  // Deprecated, shutdown 2026-10-23.
  register({
    id: "o3-mini",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o3-mini (deprecated 2026-10-23)",
    knowledgeCutoff: "2023-10-01",
    tags: ["o-series", "reasoning", "legacy"],
    capabilities: CAPS_O3_MINI_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O3_MINI,
    vendorIds: { firstParty: "o3-mini" },
  })
  register({
    id: "o3-mini-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "OpenAI o3-mini (Chat Completions) (deprecated 2026-10-23)",
    knowledgeCutoff: "2023-10-01",
    tags: ["o-series", "chat", "legacy"],
    capabilities: CAPS_O3_MINI_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O3_MINI,
    vendorIds: { firstParty: "o3-mini" },
  })

  // Deprecated, shutdown 2026-12-11.
  register({
    id: "o3-pro",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o3-pro (deprecated 2026-12-11)",
    knowledgeCutoff: "2024-06-01",
    tags: ["o-series", "pro", "reasoning", "legacy"],
    capabilities: CAPS_O3_PRO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_O3_PRO,
    vendorIds: { firstParty: "o3-pro" },
  })

  // GPT-4.1 mini.
  register({
    id: "gpt-4.1-mini",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-4.1 mini",
    knowledgeCutoff: "2024-06-01",
    tags: ["gpt-4", "long-context"],
    capabilities: CAPS_GPT_41_MINI_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_41_MINI,
    vendorIds: { firstParty: "gpt-4.1-mini" },
  })
  register({
    id: "gpt-4.1-mini-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4.1 mini (Chat Completions)",
    knowledgeCutoff: "2024-06-01",
    tags: ["gpt-4", "chat", "long-context"],
    capabilities: CAPS_GPT_41_MINI_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_41_MINI,
    vendorIds: { firstParty: "gpt-4.1-mini" },
  })

  // Deprecated, shutdown 2026-10-23.
  register({
    id: "gpt-4.1-nano",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-4.1 nano (deprecated 2026-10-23)",
    knowledgeCutoff: "2024-06-01",
    tags: ["gpt-4", "long-context", "legacy"],
    capabilities: CAPS_GPT_41_NANO_RESPONSES,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_41_NANO,
    vendorIds: { firstParty: "gpt-4.1-nano" },
  })
  register({
    id: "gpt-4.1-nano-chat",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4.1 nano (Chat Completions) (deprecated 2026-10-23)",
    knowledgeCutoff: "2024-06-01",
    tags: ["gpt-4", "chat", "long-context", "legacy"],
    capabilities: CAPS_GPT_41_NANO_CHAT,
    estimateTokens: estimateOpenAITokens,
    pricing: PRICING_GPT_41_NANO,
    vendorIds: { firstParty: "gpt-4.1-nano" },
  })

  return ids
}
