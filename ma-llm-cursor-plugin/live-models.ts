import { resolveCursorAccessToken } from "./auth.ts"
import {
  cursorHostModelId,
  cursorModelDisplayName,
  expandCursorCatalog,
  formatCursorVariantDisplayName,
} from "./catalog-expand.ts"
import { availableModelsUrl } from "./connect/hosts.ts"
import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow, ModelRegistrar } from "./lib/provider-plugin.ts"
import { registerCursorModelInto } from "./models.ts"
import { encodeAvailableModelsRequest } from "./proto/available-models-request.ts"
import {
  type DecodedAvailableModelsResponse,
  decodeAvailableModelsResponse,
} from "./proto/models-decode.ts"

export { cursorHostModelId, cursorModelDisplayName, expandCursorCatalog } from "./catalog-expand.ts"

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/**
 * Expand rich models into host live rows with **namespaced** ids.
 * Pure projection for listLiveModels merge — does not touch the registry.
 * Variant host ids prefer `legacy_slug` (CLI exploded SKU) over the
 * bracketed variant-string representation.
 */
export function mapCursorLiveModels(decoded: DecodedAvailableModelsResponse): LiveModelRow[] {
  const rows = new Map<string, LiveModelRow>()
  const add = (wireId: string, displayName?: string) => {
    if (!wireId) return
    const id = cursorHostModelId(wireId)
    if (rows.has(id)) return
    rows.set(id, { id, displayName: displayName ?? wireId })
  }
  for (const model of decoded.models) {
    if (model.isHidden) continue
    add(model.name, cursorModelDisplayName(model))
    for (const alias of unique([...(model.idAliases ?? []), ...(model.legacySlugs ?? [])])) {
      if (alias) add(alias, cursorModelDisplayName(model))
    }
    for (const variant of model.variants ?? []) {
      const wire =
        variant.legacySlug ??
        (variant.variantStringRepresentation && !variant.variantStringRepresentation.includes("[")
          ? variant.variantStringRepresentation
          : undefined)
      if (!wire) continue
      add(wire, formatCursorVariantDisplayName(cursorModelDisplayName(model), variant))
    }
  }
  for (const modelName of decoded.modelNames) {
    if (modelName) add(modelName)
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Register full ModelEntry rows (caps, surface, vendorIds) so host
 * `applyRegisteredEntry` can enrich live list rows with ctx/effort/think/tools.
 *
 * Safe to call repeatedly: same (id, providerId) is last-write-wins.
 * Never registers bare wire ids as aliases (Grok collision risk).
 *
 * **Lifecycle limitation (known):** `ModelRegistrar` has no `unregister`.
 * Rows from a previous AvailableModels snapshot (including models that later
 * become hidden/removed) stay in the host registry until process restart.
 * Live list rows still come from the latest `mapCursorLiveModels` only; stale
 * registry entries may still appear via static enrichment. Documented — not
 * closed until the host registrar grows a remove/replace-catalog API.
 *
 * @returns host ids that were registered on this call
 */
export function registerCursorLiveCatalog(
  models: ModelRegistrar,
  decoded: DecodedAvailableModelsResponse,
): string[] {
  const registered: string[] = []
  const seen = new Set<string>()
  for (const entry of expandCursorCatalog(decoded)) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    registerCursorModelInto(models, entry)
    registered.push(entry.id)
  }
  return registered
}

/** Optional registrar capture for list-time enrichment (set by adapter bootstrap). */
let liveRegistrar: ModelRegistrar | undefined

let cachedCatalog: { decoded: DecodedAvailableModelsResponse; at: number } | undefined
const LIVE_CATALOG_TTL_MS = 60_000

/** Wire the host model registrar so live catalog can publish full ModelEntry caps. */
export function setCursorLiveModelRegistrar(models: ModelRegistrar | undefined): void {
  liveRegistrar = models
}

/** Read back the registrar (tests). */
export function getCursorLiveModelRegistrar(): ModelRegistrar | undefined {
  return liveRegistrar
}

/** Test helper: drop the in-memory AvailableModels cache. */
export function resetCursorLiveCatalogCacheForTests(): void {
  cachedCatalog = undefined
}

async function fetchCursorAvailableModels(
  auth: ProviderAuth,
): Promise<DecodedAvailableModelsResponse | null> {
  const ids = await loadClientIds()
  const token = await resolveCursorAccessToken(auth)
  const response = await fetch(availableModelsUrl(), {
    method: "POST",
    headers: buildCursorHeaders({ token, ids, streaming: false, clientType: "cli" }),
    body: Buffer.from(
      encodeAvailableModelsRequest({ useModelParameters: true, doNotUseMarkdown: true }),
    ),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Cursor AvailableModels ${response.status}: ${errorBody || response.statusText}`,
      )
    }
    return null
  }
  const body = new Uint8Array(await response.arrayBuffer())
  return decodeAvailableModelsResponse(body)
}

/**
 * Fetch parameterized AvailableModels and register into the live registrar.
 * Cached briefly so AgentService/Run can await a fresh catalog without
 * re-hitting the RPC on every stream chunk.
 */
export async function ensureCursorLiveCatalog(auth: ProviderAuth): Promise<void> {
  const now = Date.now()
  if (cachedCatalog && now - cachedCatalog.at < LIVE_CATALOG_TTL_MS) {
    if (liveRegistrar) registerCursorLiveCatalog(liveRegistrar, cachedCatalog.decoded)
    return
  }
  const decoded = await fetchCursorAvailableModels(auth)
  if (!decoded) return
  cachedCatalog = { decoded, at: now }
  if (liveRegistrar) registerCursorLiveCatalog(liveRegistrar, decoded)
}

/**
 * Authenticated AvailableModels catalog.
 *
 * Auth failures (401/403) throw so the host `Promise.allSettled` path prints
 * `(live model list unavailable: …)` — same observability contract as Anthropic
 * `Models API ${status}`. Network/decode failures still soft-return `[]` so a
 * multi-provider listing can degrade to the static Cursor seed.
 *
 * On success, also registers full capability entries when a registrar is set.
 */
export async function listCursorLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  try {
    const decoded = await fetchCursorAvailableModels(auth)
    if (!decoded) return []
    cachedCatalog = { decoded, at: Date.now() }
    if (liveRegistrar) {
      try {
        registerCursorLiveCatalog(liveRegistrar, decoded)
      } catch {
        // Registration must not break the live row list.
      }
    }
    return mapCursorLiveModels(decoded)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Cursor AvailableModels ")) {
      throw err
    }
    return []
  }
}
