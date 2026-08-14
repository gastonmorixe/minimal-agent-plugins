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
 * Static seed = the authenticated AvailableModels catalog (207 visible parent
 * rows expanded to 236 host ids through aliases/legacy slugs; live probe
 * 2026-08-14 via `cursor-oauth-2`). The same expanded rows are also available
 * from live enrichment.
 *
 * Caps from `deriveCursorCapabilities` / `cursorCaps` on that probe:
 * RPC omits contextTokenLimit* → 128K default and maxOutputTokens → 16K;
 * supportsMaxMode/supportsAgent are true for every visible row; no field-29 effort
 * params → `effortLevels: []` even when `supportsThinking`; vision from
 * `supportsImages` (185/207 visible rows).
 *
 * @module llm/providers/cursor/models
 */

import { cursorCaps } from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import { PRICING_CURSOR_GENERIC } from "./pricing.ts"
import { CURSOR_STATIC_CATALOG } from "./static-catalog.ts"
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
 * Static offline catalog. Generated rows carry canonical parent and legacy host
 * ids; `cursor-auto`/`cursor-default` are added as the user-facing Auto rows.
 */
const CATALOG: CursorCatalogEntry[] = CURSOR_STATIC_CATALOG.map((row) => ({
  id: row.id,
  displayName: row.displayName,
  wireId: row.wireId,
  capabilities: cursorCaps({
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    thinking: row.supportsThinking,
    vision: row.supportsImages,
    effortLevels: row.effortLevels,
  }),
  tags: [
    "cursor",
    "live",
    ...(row.defaultOn ? ["default-on"] : []),
    ...(row.supportsThinking ? ["thinking"] : []),
    ...(row.supportsImages ? ["vision"] : []),
    "agent",
    "supports-max-mode",
  ],
}))

// Auto is a display alias for Cursor's canonical `default` model. Keep both
// host ids offline without adding a bare `auto` alias that can collide globally.
CATALOG.unshift({
  id: "cursor-auto",
  displayName: "Auto (Cursor)",
  wireId: "default",
  capabilities: cursorCaps({ contextWindow: 128 * K, vision: true, effortLevels: [] }),
  tags: ["cursor", "auto", "default", "agent", "supports-max-mode"],
})

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
