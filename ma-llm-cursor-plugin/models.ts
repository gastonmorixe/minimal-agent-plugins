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

/** Map a user/host slug to the bare Cursor wire model id for Run. */
export function resolveCursorWireId(slug: string): string {
  const bare = slug.replace(/^cursor-/, "")
  return CURSOR_WIRE_ID_ALIASES[bare] ?? bare
}

/**
 * Static offline seed. Thinking/effort empty until live catalog enriches with
 * effort-param:<id> (Christina: no selectable knobs without wire id).
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
    tags: ["cursor", "auto", "default", "agent"],
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
    tags: ["cursor", "auto", "default", "agent", "canonical:default"],
  },
  {
    id: "cursor-composer-2.5-fast",
    displayName: "Composer 2.5 Fast (Cursor)",
    wireId: "composer-2.5-fast",
    capabilities: cursorCaps({
      contextWindow: 200 * K,
      thinking: true,
      vision: false,
      effortLevels: [],
    }),
    tags: ["cursor", "composer", "fast", "thinking"],
  },
  {
    id: "cursor-composer-2",
    displayName: "Composer 2 (Cursor)",
    wireId: "composer-2",
    capabilities: cursorCaps({
      contextWindow: 200 * K,
      thinking: true,
      vision: false,
      effortLevels: [],
    }),
    tags: ["cursor", "composer", "thinking"],
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
  const bare = modelId.replace(/^cursor-/, "")
  const hostId = modelId.startsWith("cursor-") ? modelId : `cursor-${bare}`
  const wireId = resolveCursorWireId(bare)
  const tags = ["cursor", "ad-hoc"]
  if (wireId !== bare) {
    tags.push("alias", `canonical:${wireId}`)
  }
  return registerCursorModelInto(models, {
    id: hostId,
    wireId,
    displayName: bare === "auto" || bare === "default" ? "Auto (Cursor)" : `${bare} (Cursor)`,
    // Ad-hoc: thinking ok, no effort levels without catalog effort-param tag.
    // Auto/default: match catalog (no thinking advertised on Auto).
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: bare !== "auto" && bare !== "default",
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
  if (fromVendor) return resolveCursorWireId(fromVendor)
  return resolveCursorWireId(model.id)
}
