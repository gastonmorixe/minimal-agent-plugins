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

const CATALOG: CursorCatalogEntry[] = [
  {
    id: "cursor-composer-2.5-fast",
    displayName: "Composer 2.5 Fast (Cursor)",
    wireId: "composer-2.5-fast",
    capabilities: cursorCaps({
      contextWindow: 200 * K,
      thinking: true,
      vision: false,
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

/** Populate the host registry with the static Cursor seed. Default = first. */
export function registerCursorModels(models: ModelRegistrar): string[] {
  const ids = CATALOG.map((entry) => registerCursorModelInto(models, entry))
  if (ids[0]) models.setDefault(ids[0])
  return ids
}

/**
 * Register a one-off Cursor slug.
 * Namespaces host id as `cursor-<slug>` when the caller passes a bare API id.
 */
export function registerCursorAdHocModelInto(models: ModelRegistrar, modelId: string): string {
  const bare = modelId.replace(/^cursor-/, "")
  const hostId = modelId.startsWith("cursor-") ? modelId : `cursor-${bare}`
  return registerCursorModelInto(models, {
    id: hostId,
    wireId: bare,
    displayName: `${bare} (Cursor)`,
    capabilities: cursorCaps({ contextWindow: 128 * K, thinking: true }),
    tags: ["cursor", "ad-hoc"],
  })
}

/** Resolve wire model id for Run requests from a host ModelEntry-like object. */
export function cursorWireModelId(model: {
  id: string
  vendorIds?: Record<string, string>
}): string {
  return model.vendorIds?.cursor ?? model.vendorIds?.firstParty ?? model.id.replace(/^cursor-/, "")
}
