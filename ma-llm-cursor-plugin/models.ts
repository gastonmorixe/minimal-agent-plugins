/**
 * Cursor static model seed + ad-hoc registration.
 *
 * Offline fallback so `--list-models` / picker work before live catalog.
 *
 * **Ids must be provider-namespaced.** Grok registers
 * `grok-composer-2.5-fast` with **alias** `composer-2.5-fast`. Registering bare
 * `composer-2.5-fast` as a Cursor model id crashes host boot:
 * `alias "composer-2.5-fast" collides with an existing model id`.
 *
 * Wire slug for AgentService/Run is stored in `vendorIds.cursor` (bare API id).
 *
 * Static seed = AvailableModels `defaultOn` + Composer sibling `composer-2.5`
 * (live probe 2026-07-30 via Cursor Browser Login / `cursor-oauth`). Full
 * catalog (~196 visible rows) still comes from live enrichment.
 *
 * Caps from `deriveCursorCapabilities` / `cursorCaps` on that probe:
 * RPC omits contextTokenLimit* → 128K default; no field-29 effort params →
 * `effortLevels: []` even when `supportsThinking`; vision from `supportsImages`.
 *
 * @module llm/providers/cursor/models
 */

import { cursorCaps } from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import { PRICING_CURSOR_GENERIC } from "./pricing.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const K = 1_000

const estimateCursorTokens = makeCharRatioEstimator(3.8)

export interface CursorCatalogEntry {
  /** Host registry id — must not collide with other providers' ids/aliases. */
  id: string
  displayName: string
  /** Bare Cursor API model slug for AgentService/Run. */
  wireId: string
  capabilities: Capabilities
  tags: string[]
}

/**
 * Known display-slug → AgentService/Run wire id.
 * Cursor's Auto picker id is `auto`, but Run rejects it with connect
 * `not_found`; the API model_id is `default` (AvailableModels / GetUsableModels).
 * Ad-hoc registration and offline seed must use these, not the bare slug.
 */
export const CURSOR_WIRE_ID_ALIASES: Readonly<Record<string, string>> = {
  auto: "default",
}

/**
 * Map a user/host slug to the Cursor wire model id for Run.
 *
 * Strips one host `cursor-` namespace except when the API wire id itself starts
 * with `cursor-` (Cursor Grok SKUs: `cursor-grok-4.5-high-fast`). Those share
 * host id === wire id; stripping would send a not_found slug.
 */
export function resolveCursorWireId(slug: string): string {
  if (CURSOR_WIRE_ID_ALIASES[slug]) return CURSOR_WIRE_ID_ALIASES[slug]!
  if (!slug.startsWith("cursor-")) return slug
  const bare = slug.slice("cursor-".length)
  if (CURSOR_WIRE_ID_ALIASES[bare]) return CURSOR_WIRE_ID_ALIASES[bare]!
  // First-party Cursor product wires keep the `cursor-` prefix on the wire.
  if (bare.startsWith("grok-")) return slug
  return bare
}

/**
 * Static offline seed (2026-07-30). Order: Auto alias + canonical, then live
 * `defaultOn` order, plus non-default sibling `composer-2.5`.
 *
 * Live defaultOn wire ids: `default`, `cursor-grok-4.5-high-fast`,
 * `composer-2.5-fast`, `claude-opus-5-thinking-high`, `gpt-5.6-sol-medium`,
 * `claude-fable-5-thinking-high`, `claude-sonnet-5-thinking-high`,
 * `gpt-5.6-terra-medium`.
 */
const CATALOG: CursorCatalogEntry[] = [
  {
    // Auto: host id uses the display slug users type (`cursor-auto`); wire is `default`.
    id: "cursor-auto",
    displayName: "Auto (Cursor)",
    wireId: "default",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: false,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "auto", "default", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-default",
    displayName: "Auto (Cursor)",
    wireId: "default",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: false,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "auto", "default", "agent", "canonical:default", "supports-max-mode"],
  },
  {
    // Wire id already starts with `cursor-`; host id stays the same namespace.
    id: "cursor-grok-4.5-high-fast",
    displayName: "Cursor Grok 4.5 Fast",
    wireId: "cursor-grok-4.5-high-fast",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: false,
      effortLevels: [],
    }),
    tags: ["cursor", "grok", "fast", "thinking", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-composer-2.5-fast",
    displayName: "Composer 2.5 Fast (Cursor)",
    wireId: "composer-2.5-fast",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: false,
      effortLevels: [],
    }),
    tags: ["cursor", "composer", "fast", "thinking", "agent", "supports-max-mode"],
  },
  {
    // Sibling of composer-2.5-fast (not defaultOn; kept for offline picker).
    id: "cursor-composer-2.5",
    displayName: "Composer 2.5 (Cursor)",
    wireId: "composer-2.5",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: false,
      effortLevels: [],
    }),
    tags: ["cursor", "composer", "thinking", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-claude-opus-5-thinking-high",
    displayName: "Opus 5 (Cursor)",
    wireId: "claude-opus-5-thinking-high",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "claude", "opus", "thinking", "vision", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-gpt-5.6-sol-medium",
    displayName: "GPT-5.6 Sol (Cursor)",
    wireId: "gpt-5.6-sol-medium",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "gpt", "sol", "thinking", "vision", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-claude-fable-5-thinking-high",
    displayName: "Fable 5 (Cursor)",
    wireId: "claude-fable-5-thinking-high",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "claude", "fable", "thinking", "vision", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-claude-sonnet-5-thinking-high",
    displayName: "Sonnet 5 (Cursor)",
    wireId: "claude-sonnet-5-thinking-high",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "claude", "sonnet", "thinking", "vision", "agent", "supports-max-mode"],
  },
  {
    id: "cursor-gpt-5.6-terra-medium",
    displayName: "GPT-5.6 Terra (Cursor)",
    wireId: "gpt-5.6-terra-medium",
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: true,
      vision: true,
      effortLevels: [],
    }),
    tags: ["cursor", "gpt", "terra", "thinking", "vision", "agent", "supports-max-mode"],
  },
]

/** Register one Cursor model into the host registry. */
export function registerCursorModelInto(models: ModelRegistrar, entry: CursorCatalogEntry): string {
  const spec: ProviderModelSpec = {
    id: entry.id,
    providerId: "cursor",
    surfaceId: CURSOR_SURFACE_AGENT_RUN,
    displayName: entry.displayName,
    tags: entry.tags,
    capabilities: entry.capabilities,
    // Pricing opaque on AvailableModels — zero rates (see pricing.ts).
    pricing: PRICING_CURSOR_GENERIC,
    estimateTokens: estimateCursorTokens,
    // Never put bare wire ids in `aliases` — they collide with Grok et al.
    vendorIds: { cursor: entry.wireId, firstParty: entry.wireId },
  }
  models.register(spec)
  return entry.id
}

/** Populate the host registry with the static Cursor seed. Default = Auto. */
export function registerCursorModels(models: ModelRegistrar): string[] {
  const ids = CATALOG.map((entry) => registerCursorModelInto(models, entry))
  // Prefer Auto (`cursor-auto`) when present; else first seed entry.
  const defaultId = ids.find((id) => id === "cursor-auto") ?? ids[0]
  if (defaultId) models.setDefault(defaultId)
  return ids
}

/**
 * Register a one-off Cursor slug.
 * Namespaces host id as `cursor-<slug>` when the caller passes a bare API id.
 * Wire id resolves known display aliases (e.g. `auto` → `default`).
 */
export function registerCursorAdHocModelInto(models: ModelRegistrar, modelId: string): string {
  const hostId = modelId.startsWith("cursor-") ? modelId : `cursor-${modelId}`
  const wireId = resolveCursorWireId(hostId)
  const hostBare = hostId.slice("cursor-".length)
  const tags = ["cursor", "ad-hoc"]
  if (CURSOR_WIRE_ID_ALIASES[hostBare]) {
    tags.push("alias", `canonical:${wireId}`)
  }
  return registerCursorModelInto(models, {
    id: hostId,
    wireId,
    displayName:
      hostId === "cursor-auto" || hostId === "cursor-default"
        ? "Auto (Cursor)"
        : `${hostBare} (Cursor)`,
    // Ad-hoc: thinking ok, no effort levels without catalog effort-param tag.
    // Auto/default: match catalog (no thinking advertised on Auto).
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: hostId !== "cursor-auto" && hostId !== "cursor-default",
      effortLevels: [],
    }),
    tags,
  })
}

/** Resolve wire model id for Run requests from a host ModelEntry-like object. */
export function cursorWireModelId(model: {
  id: string
  vendorIds?: Record<string, string>
}): string {
  const fromVendor = model.vendorIds?.cursor ?? model.vendorIds?.firstParty
  if (fromVendor) {
    // vendorIds.cursor is the Run model_id (exact), except Auto display aliases.
    return CURSOR_WIRE_ID_ALIASES[fromVendor] ?? fromVendor
  }
  return resolveCursorWireId(model.id)
}
