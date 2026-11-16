/**
 * Anthropic model registry entries.
 *
 * Calling `registerAnthropicModels()` populates the canonical model
 * registry with every model in the live Anthropic catalog as of
 * 2026-11-15 (verified via the plugin's own `listLiveModels` hook, i.e.
 * `GET /v1/models?beta=true`). Live count is 14 base models plus 12
 * client-synthesized `[1m]` variants (see `list-models.ts`), which are
 * aliases here, not separate entries. Changes since 2026-11-01:
 * `claude-fable-5-2` (2026-11-09) added; `claude-sonnet-4-5-20250929` is no
 * longer listed live, so its entry is removed (a `--model claude-sonnet-4-5`
 * selection now falls through to the ad-hoc Sonnet family profile).
 * Pricing comes from the typed
 * tables in `pricing.ts`;
 * capabilities come from `capabilities.ts`. `[1m]` aliases let the
 * caller request 1M context explicitly even when the default already
 * exposes it.
 *
 * @module llm/providers/anthropic/models
 */

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"

import {
  CAPS_FABLE_5,
  CAPS_FABLE_5_1,
  CAPS_FABLE_5_2,
  CAPS_HAIKU_45,
  CAPS_HAIKU_55,
  CAPS_OPUS_5,
  CAPS_OPUS_45,
  CAPS_OPUS_46,
  CAPS_OPUS_47,
  CAPS_OPUS_48,
  CAPS_OPUS_55,
  CAPS_SONNET_5,
  CAPS_SONNET_46,
  CAPS_SONNET_55,
} from "./capabilities.ts"
import type { ModelEntry, MTokRate } from "./lib/host-types.ts"
import { clearLocalCatalog, recordModel } from "./lib/registry.ts"
import {
  ANTHROPIC_FABLE_5,
  ANTHROPIC_FABLE_5_1,
  ANTHROPIC_FABLE_5_2,
  ANTHROPIC_FABLE_5_2_FAST,
  ANTHROPIC_HAIKU_45,
  ANTHROPIC_HAIKU_55,
  ANTHROPIC_OPUS_4X_FAST_LEGACY,
  ANTHROPIC_OPUS_4X_STANDARD,
  ANTHROPIC_OPUS_48_FAST,
  ANTHROPIC_OPUS_55_FAST,
  ANTHROPIC_OPUS_55_STANDARD,
  ANTHROPIC_SONNET_5_INTRO,
  ANTHROPIC_SONNET_55,
  ANTHROPIC_SONNET_STANDARD,
} from "./pricing.ts"

/**
 * The neutral {@link ProviderModelSpec} plus the optional per-request pricing
 * picker the Anthropic catalog needs (the `speed:"fast"` rate switch). It is a
 * subtype of `ProviderModelSpec`, so a spec built here registers through the
 * host {@link ModelRegistrar} unchanged; the picker rides along on the object
 * and the registry's `ModelEntry.pricingForRequest` slot consumes it.
 */
type AnthropicModelSpec = ProviderModelSpec & {
  pricingForRequest?: (req: CanonicalRequest) => MTokRate
}

// ---------------------------------------------------------------------------
// Per-model pricing pickers (handle speed:"fast" rate switch)
// ---------------------------------------------------------------------------

const opus48PricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_48_FAST : ANTHROPIC_OPUS_4X_STANDARD

/**
 * Opus 5.5 rate picker: $8/$40 on the fast tier, $4/$20 standard. Opus 5.5
 * has its own rate pair (the rest of the opus family shares `opus48`).
 */
const opus55PricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_55_FAST : ANTHROPIC_OPUS_55_STANDARD

const legacyOpusFastPricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_4X_FAST_LEGACY : ANTHROPIC_OPUS_4X_STANDARD

/**
 * Fable 5.2 rate picker: $16/$80 on the fast tier, $8/$40 standard. Fable 5.2
 * is the only Fable with a fast tier (5 and 5.1 are flat-rate), and it is the
 * cheapest base rate in the family despite being the newest.
 */
const fable52PricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_FABLE_5_2_FAST : ANTHROPIC_FABLE_5_2

/**
 * Prompt length at which Haiku 5.5 leaves its base rate. Mirrors the server's
 * own accounting: the threshold counts input tokens PLUS cache reads PLUS
 * cache writes, because the pricing page defines prompt length that way ("A
 * request's prompt length counts all of its input tokens, including cache
 * reads and cache writes"). Omitting the cache terms would under-count a
 * cached long prompt and silently bill it at the cheap rate.
 *
 * Exported for unit testing the boundary without a live request.
 *
 * @param req - The request about to be sent.
 * @returns The prompt token total the long-prompt gate compares against.
 */
export function haiku55PromptTokens(req: CanonicalRequest): number {
  // `requestPromptChars` covers the system blocks, the message content, and
  // the tool schemas. Cache read/write totals are not known before the
  // response (they are server-reported), so the pre-flight estimate counts
  // cached blocks as ordinary input. That is the right conservative reading:
  // a cached long prompt is exactly the case that must not be billed at the
  // base rate. A string of the measured length avoids building a large copy.
  const chars = requestPromptChars(req)
  return chars === 0 ? 0 : estimateAnthropicTokens(" ".repeat(chars))
}

/** Character length of one canonical block, for the prompt-length estimate. */
function blockChars(block: CanonicalBlock): number {
  switch (block.type) {
    case "text":
    case "thinking":
      return block.text.length
    case "redacted_thinking":
      return block.data.length
    case "tool_use":
      return block.name.length + safeJsonLength(block.input)
    case "tool_result": {
      let chars = 0
      for (const inner of block.content) chars += blockChars(inner)
      return chars
    }
    default:
      // image / audio / file: no text to measure here.
      return 0
  }
}

/** Length of `JSON.stringify(value)`, or 0 when it cannot be serialized. */
function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/** Total characters of system blocks, message content, and tool schemas. */
function requestPromptChars(req: CanonicalRequest): number {
  let chars = 0
  for (const block of req.system ?? []) chars += blockChars(block)
  for (const msg of req.messages) {
    for (const block of msg.content) chars += blockChars(block)
  }
  for (const tool of req.tools ?? []) {
    chars += tool.name.length + tool.description.length + safeJsonLength(tool.inputSchema)
  }
  return chars
}

/**
 * First instant (UTC) at which Claude Sonnet 5 leaves introductory pricing.
 * The launch post promises intro rates "through August 31, 2026", so the
 * standard rate applies from 2026-09-01T00:00:00Z onward.
 */
const SONNET_5_STANDARD_PRICING_FROM = Date.UTC(2026, 8, 1) // month is 0-based: 8 = September

/**
 * Pure date-gated rate selector for Sonnet 5: the introductory $2/$10 rate
 * before the cutover, the standard $3/$15 rate on/after it. Exported for
 * unit testing so the boundary is pinned without mocking the clock.
 *
 * @param nowMs - epoch milliseconds to evaluate against (defaults to now).
 */
export function sonnet5RateForDate(nowMs: number = Date.now()): MTokRate {
  return nowMs < SONNET_5_STANDARD_PRICING_FROM
    ? ANTHROPIC_SONNET_5_INTRO
    : ANTHROPIC_SONNET_STANDARD
}

/**
 * Per-request pricing picker for Sonnet 5. Pricing depends on the wall clock
 * (intro vs standard), not the request shape, so the request is ignored; the
 * date gate lives in {@link sonnet5RateForDate}.
 */
const sonnet5PricingFor = (_req: CanonicalRequest): MTokRate => sonnet5RateForDate()

/**
 * Token estimator for Anthropic's tokenizer family. ~3.5 chars/token is the
 * ratio the live output-token estimate in `src/client.ts` already uses, so
 * estimated session totals stay consistent with the live footer. Shared by
 * every Anthropic model entry.
 */
const estimateAnthropicTokens = makeCharRatioEstimator(3.5)

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Populate the canonical model registry with the current Anthropic
 * catalog. Idempotent : safe to call multiple times (re-registration
 * is last-write-wins).
 *
 * Registry seam (Wave D): when the host passes a {@link ModelRegistrar} (the
 * `models:register` capability, threaded through `register(ctx)`), the catalog
 * is contributed through `ctx.models.register` — no `src/` import needed. When
 * no registrar is supplied (the legacy no-arg activation path, or a direct call
 * in a test), it falls back to the imported `registerModel`. This lets the live
 * provider-loader adopt the ctx-driven path provider-by-provider without
 * breaking the no-context callers.
 *
 * @param registrar - Host model registrar (the `models:register` capability),
 *   handed in at `register(ctx)`. As a moved plugin there is no host-registry
 *   fallback import: the registrar is always present.
 * @returns the registered ids for testability.
 */
export function registerAnthropicModels(registrar: ModelRegistrar): string[] {
  // Single registration sink: contribute each spec to the host registry through
  // the injected registrar AND mirror it into the plugin-local catalog so the
  // plugin's own aux paths (header/probe builders, footer context lookup, beta
  // gating) can resolve a model without a host `src/` import. The local spec
  // type widens `ProviderModelSpec` with the optional `pricingForRequest`
  // picker (the speed:"fast" rate switch the Anthropic catalog needs but the
  // neutral contract omits); it stays assignable to `ProviderModelSpec`.
  clearLocalCatalog()
  const register = (spec: AnthropicModelSpec): void => {
    registrar.register(spec)
    recordModel(spec as unknown as ModelEntry)
  }
  register({
    id: "claude-haiku-5-5",
    aliases: ["claude-haiku-5-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Haiku 5.5",
    tags: ["haiku", "1m-context", "fast", "production"],
    capabilities: CAPS_HAIKU_55,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_HAIKU_55,
    vendorIds: {
      firstParty: "claude-haiku-5-5",
      bedrock: "us.anthropic.claude-haiku-5-5",
      vertex: "claude-haiku-5-5",
      foundry: "claude-haiku-5-5",
      anthropicAws: "claude-haiku-5-5",
      mantle: "anthropic.claude-haiku-5-5",
      gateway: "claude-haiku-5-5",
    },
  })

  register({
    id: "claude-sonnet-5-5",
    aliases: ["claude-sonnet-5-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Sonnet 5.5",
    tags: ["sonnet", "1m-context", "flagship", "production"],
    capabilities: CAPS_SONNET_55,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_SONNET_55,
    vendorIds: {
      firstParty: "claude-sonnet-5-5",
      bedrock: "us.anthropic.claude-sonnet-5-5",
      vertex: "claude-sonnet-5-5",
      foundry: "claude-sonnet-5-5",
      anthropicAws: "claude-sonnet-5-5",
      mantle: "anthropic.claude-sonnet-5-5",
      gateway: "claude-sonnet-5-5",
    },
  })

  register({
    id: "claude-opus-5-5",
    aliases: ["claude-opus-5-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 5.5",
    knowledgeCutoff: "2026-06",
    tags: ["opus", "1m-context", "flagship", "production"],
    capabilities: CAPS_OPUS_55,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_55_STANDARD,
    pricingForRequest: opus55PricingFor,
    vendorIds: {
      firstParty: "claude-opus-5-5",
      bedrock: "us.anthropic.claude-opus-5-5",
      vertex: "claude-opus-5-5",
      foundry: "claude-opus-5-5",
      anthropicAws: "claude-opus-5-5",
      mantle: "anthropic.claude-opus-5-5",
      gateway: "claude-opus-5-5",
    },
  })

  register({
    id: "claude-opus-5",
    aliases: ["claude-opus-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 5",
    knowledgeCutoff: "2026-01",
    tags: ["opus", "1m-context", "flagship", "production"],
    capabilities: CAPS_OPUS_5,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: opus48PricingFor,
    vendorIds: {
      firstParty: "claude-opus-5",
      bedrock: "us.anthropic.claude-opus-5",
      vertex: "claude-opus-5",
      foundry: "claude-opus-5",
      anthropicAws: "claude-opus-5",
      mantle: "anthropic.claude-opus-5",
      gateway: "claude-opus-5",
    },
  })

  register({
    id: "claude-fable-5-2",
    aliases: ["claude-fable-5-2[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Fable 5.2",
    // models.dev `knowledge: "2026-06"` (live GET /v1/models omits it).
    knowledgeCutoff: "2026-06",
    tags: ["fable", "mythos", "1m-context", "production"],
    capabilities: CAPS_FABLE_5_2,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_FABLE_5_2,
    pricingForRequest: fable52PricingFor,
    vendorIds: {
      firstParty: "claude-fable-5-2",
      bedrock: "us.anthropic.claude-fable-5-2",
      vertex: "claude-fable-5-2",
      foundry: "claude-fable-5-2",
      anthropicAws: "claude-fable-5-2",
      mantle: "anthropic.claude-fable-5-2",
      gateway: "claude-fable-5-2",
    },
  })

  register({
    id: "claude-fable-5-1",
    aliases: ["claude-fable-5-1[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Fable 5.1",
    knowledgeCutoff: "2026-01",
    tags: ["fable", "mythos", "1m-context", "production"],
    capabilities: CAPS_FABLE_5_1,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_FABLE_5_1,
    vendorIds: {
      firstParty: "claude-fable-5-1",
      bedrock: "us.anthropic.claude-fable-5-1",
      vertex: "claude-fable-5-1",
      foundry: "claude-fable-5-1",
      anthropicAws: "claude-fable-5-1",
      mantle: "anthropic.claude-fable-5-1",
      gateway: "claude-fable-5-1",
    },
  })

  register({
    id: "claude-fable-5",
    aliases: ["claude-fable-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Fable 5",
    knowledgeCutoff: "2026-01",
    tags: ["fable", "mythos", "1m-context", "flagship", "production"],
    capabilities: CAPS_FABLE_5,
    estimateTokens: estimateAnthropicTokens,
    // Fable ships a single flat rate (no speed:"fast" tier), so no
    // pricingForRequest picker : the base `pricing` always applies.
    pricing: ANTHROPIC_FABLE_5,
    vendorIds: {
      firstParty: "claude-fable-5",
      bedrock: "us.anthropic.claude-fable-5",
      vertex: "claude-fable-5",
      foundry: "claude-fable-5",
      anthropicAws: "claude-fable-5",
      mantle: "anthropic.claude-fable-5",
      gateway: "claude-fable-5",
    },
  })

  register({
    id: "claude-opus-4-8",
    aliases: ["claude-opus-4-8[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.8",
    knowledgeCutoff: "2026-01",
    tags: ["opus", "1m-context", "flagship", "production"],
    capabilities: CAPS_OPUS_48,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: opus48PricingFor,
    vendorIds: {
      firstParty: "claude-opus-4-8",
      bedrock: "us.anthropic.claude-opus-4-8",
      vertex: "claude-opus-4-8",
      foundry: "claude-opus-4-8",
      anthropicAws: "claude-opus-4-8",
      mantle: "anthropic.claude-opus-4-8",
      gateway: "claude-opus-4-8",
    },
  })

  register({
    id: "claude-opus-4-7",
    aliases: ["claude-opus-4-7[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.7",
    knowledgeCutoff: "2026-01",
    tags: ["opus", "1m-context", "production"],
    capabilities: CAPS_OPUS_47,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: legacyOpusFastPricingFor,
    vendorIds: {
      firstParty: "claude-opus-4-7",
      bedrock: "us.anthropic.claude-opus-4-7",
      vertex: "claude-opus-4-7",
      foundry: "claude-opus-4-7",
      anthropicAws: "claude-opus-4-7",
      mantle: "anthropic.claude-opus-4-7",
      gateway: "claude-opus-4-7",
    },
  })

  register({
    id: "claude-opus-4-6",
    aliases: ["claude-opus-4-6[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.6",
    knowledgeCutoff: "2025-05",
    tags: ["opus", "1m-context", "legacy"],
    capabilities: CAPS_OPUS_46,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: legacyOpusFastPricingFor,
    vendorIds: {
      firstParty: "claude-opus-4-6",
      bedrock: "us.anthropic.claude-opus-4-6-v1",
      vertex: "claude-opus-4-6",
      foundry: "claude-opus-4-6",
      anthropicAws: "claude-opus-4-6",
      gateway: "claude-opus-4-6",
    },
  })

  register({
    id: "claude-sonnet-5",
    aliases: ["claude-sonnet-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Sonnet 5",
    knowledgeCutoff: "2026-01",
    tags: ["sonnet", "1m-context", "flagship", "production"],
    capabilities: CAPS_SONNET_5,
    estimateTokens: estimateAnthropicTokens,
    // Base rate is the introductory $2/$10; the date-gated picker swaps to
    // the $3/$15 standard rate on 2026-09-01 (see sonnet5PricingFor).
    pricing: ANTHROPIC_SONNET_5_INTRO,
    pricingForRequest: sonnet5PricingFor,
    vendorIds: {
      firstParty: "claude-sonnet-5",
      bedrock: "us.anthropic.claude-sonnet-5",
      vertex: "claude-sonnet-5",
      foundry: "claude-sonnet-5",
      anthropicAws: "claude-sonnet-5",
      mantle: "anthropic.claude-sonnet-5",
      gateway: "claude-sonnet-5",
    },
  })

  register({
    id: "claude-sonnet-4-6",
    aliases: ["claude-sonnet-4-6[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Sonnet 4.6",
    knowledgeCutoff: "2025-08",
    tags: ["sonnet", "1m-context", "production"],
    capabilities: CAPS_SONNET_46,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_SONNET_STANDARD,
    vendorIds: {
      firstParty: "claude-sonnet-4-6",
      bedrock: "us.anthropic.claude-sonnet-4-6",
      vertex: "claude-sonnet-4-6",
      foundry: "claude-sonnet-4-6",
      anthropicAws: "claude-sonnet-4-6",
      gateway: "claude-sonnet-4-6",
    },
  })

  register({
    id: "claude-opus-4-5-20251101",
    aliases: ["claude-opus-4-5"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.5",
    knowledgeCutoff: "2025-01",
    tags: ["opus", "legacy"],
    capabilities: CAPS_OPUS_45,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    vendorIds: {
      firstParty: "claude-opus-4-5-20251101",
      bedrock: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      vertex: "claude-opus-4-5@20251101",
      foundry: "claude-opus-4-5",
      anthropicAws: "claude-opus-4-5-20251101",
      gateway: "claude-opus-4-5-20251101",
    },
  })

  register({
    id: "claude-haiku-4-5-20251001",
    aliases: ["claude-haiku-4-5"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Haiku 4.5",
    knowledgeCutoff: "2025-02",
    tags: ["haiku", "fast", "production"],
    capabilities: CAPS_HAIKU_45,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_HAIKU_45,
    vendorIds: {
      firstParty: "claude-haiku-4-5-20251001",
      bedrock: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      vertex: "claude-haiku-4-5@20251001",
      foundry: "claude-haiku-4-5",
      anthropicAws: "claude-haiku-4-5-20251001",
      mantle: "anthropic.claude-haiku-4-5",
      gateway: "claude-haiku-4-5-20251001",
    },
  })

  return [
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ]
}

// ---------------------------------------------------------------------------
// Ad-hoc registration (unknown / not-yet-cataloged Claude ids)
// ---------------------------------------------------------------------------

/**
 * Family-default profile for an unknown Claude id: the capability table and
 * base pricing to assume. Each maps to an EXISTING, tested table so an ad-hoc
 * model behaves like the closest known sibling of its family rather than a
 * generic guess. The default rung is the latest production member of the
 * family (e.g. a future `claude-opus-4-9` inherits Opus 4.8's surface).
 */
interface FamilyDefault {
  capabilities: Capabilities
  pricing: MTokRate
  tags: ReadonlyArray<string>
}

/**
 * Infer the {@link FamilyDefault} for an arbitrary Claude id by family token.
 * Order matters only in that each branch is mutually exclusive on the family
 * word. Falls back to the Sonnet profile (the mid-tier, most-common default)
 * for an id that names no recognized family. The returned tables are the same
 * objects the static catalog uses, so ad-hoc models stay consistent with their
 * cataloged siblings and cost accounting is as accurate as the family allows.
 */
function familyDefaultFor(modelId: string): FamilyDefault {
  if (modelId.includes("opus")) {
    return {
      capabilities: CAPS_OPUS_48,
      pricing: ANTHROPIC_OPUS_4X_STANDARD,
      tags: ["opus", "adhoc"],
    }
  }
  if (modelId.includes("haiku")) {
    return { capabilities: CAPS_HAIKU_45, pricing: ANTHROPIC_HAIKU_45, tags: ["haiku", "adhoc"] }
  }
  if (modelId.includes("fable") || modelId.includes("mythos")) {
    return { capabilities: CAPS_FABLE_5, pricing: ANTHROPIC_FABLE_5, tags: ["fable", "adhoc"] }
  }
  // Default + explicit "sonnet": assume the current Sonnet-class surface.
  return {
    capabilities: CAPS_SONNET_5,
    pricing: ANTHROPIC_SONNET_5_INTRO,
    tags: ["sonnet", "adhoc"],
  }
}

/**
 * Register a synthetic entry for a Claude id the static catalog does not know
 * yet (e.g. a brand-new SKU announced after this build). The host calls this
 * via {@link ProviderPlugin.registerAdHocModel} when a `--model <id>` selection
 * misses the registry, so an as-yet-uncataloged Claude model boots with the
 * capability + pricing profile of its closest known family sibling instead of
 * hard-failing with "unknown model".
 *
 * Idempotent (last-write-wins). Marked with an `adhoc` tag and a `displayName`
 * suffix so it is visibly distinct from a first-class cataloged entry. Pricing
 * is a best-effort family default and may not match the real SKU rate; a model
 * that warrants accurate accounting should get a real catalog entry.
 *
 * @param registrar - The host model registrar (captured at activation).
 * @param modelId - The unknown Claude id to synthesize.
 * @returns the registered id, for testability.
 */
export function registerAnthropicAdHocModelInto(
  registrar: ModelRegistrar,
  modelId: string,
): string {
  // Strip a client-side [1m] suffix for the canonical id; re-add as alias when
  // present so `--model claude-foo[1m]` still resolves to the bare entry.
  const bare = modelId.replace(/\[1m\]$/i, "")
  const wants1m = bare !== modelId
  const { capabilities, pricing, tags } = familyDefaultFor(bare)
  const spec = {
    id: bare,
    aliases: wants1m ? [`${bare}[1m]`] : undefined,
    providerId: "anthropic",
    surfaceId: "anthropic-messages" as const,
    displayName: `${bare} (ad-hoc)`,
    capabilities,
    pricing,
    estimateTokens: estimateAnthropicTokens,
    tags: [...tags],
    vendorIds: { firstParty: bare },
  }
  registrar.register(spec)
  recordModel(spec as unknown as ModelEntry)
  return bare
}
