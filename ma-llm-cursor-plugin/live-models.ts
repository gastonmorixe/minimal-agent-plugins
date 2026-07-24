import { resolveCursorAccessToken } from "./auth.ts"
import {
  deriveCursorCapabilities,
  deriveCursorVariantCapabilities,
  resolveCursorEffortParamId,
} from "./capabilities.ts"
import { availableModelsUrl } from "./connect/hosts.ts"
import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow, ModelRegistrar } from "./lib/provider-plugin.ts"
import { registerCursorModelInto } from "./models.ts"
import {
  type DecodedAvailableModelsResponse,
  type DecodedCursorModel,
  decodeAvailableModelsResponse,
} from "./proto/models-decode.ts"

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** Prefer client display name, then short name, then wire id. */
export function cursorModelDisplayName(model: DecodedCursorModel): string {
  return model.clientDisplayName ?? model.inputboxShortModelName ?? model.name
}

/**
 * Host registry id for a bare Cursor API slug.
 * Always `cursor-…` so we never collide with Grok aliases like `composer-2.5-fast`.
 */
export function cursorHostModelId(wireId: string): string {
  const bare = wireId.replace(/^cursor-/, "")
  return bare.startsWith("cursor-") ? bare : `cursor-${bare}`
}

/**
 * Registration tags for Jack RequestedModel encode + list diagnostics.
 *
 * **max-mode vs supports-max-mode** (Christina review):
 * - `supports-max-mode` — catalog capability: this model *can* use max mode
 *   (from AvailableModel.supportsMaxMode). Safe on parent/alias/variant.
 * - `max-mode` — **selected** max configuration only (variant.isMaxMode).
 *   Jack's encoder treats `max-mode` as RequestedModel.max_mode=true.
 *   Never stamp `max-mode` from parent.supportsMaxMode alone — that forced
 *   canonical selections onto max=true incorrectly.
 */
function tagsForModel(
  model: DecodedCursorModel,
  extra: string[] = [],
  options?: { effortParamId?: string },
): string[] {
  const tags = new Set<string>(["cursor", "live", ...extra])
  if (model.supportsThinking) tags.add("thinking")
  if (model.supportsImages) tags.add("vision")
  if (model.supportsMaxMode) tags.add("supports-max-mode")
  if (model.supportsAgent) tags.add("agent")
  if (model.isLongContextOnly) tags.add("long-context")
  // Bridge for Jack wire encode: real RequestedModel.parameters id (not hardcoded "effort").
  if (options?.effortParamId) tags.add(`effort-param:${options.effortParamId}`)
  return [...tags]
}

/**
 * Expand rich models into host live rows with **namespaced** ids.
 * Pure projection for listLiveModels merge — does not touch the registry.
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
    // Aliases/variants become extra host ids, still namespaced — not bare aliases
    // on the primary model (core forbids alias==other provider model id).
    for (const alias of unique([...(model.idAliases ?? []), ...(model.legacySlugs ?? [])])) {
      if (alias) add(alias, cursorModelDisplayName(model))
    }
    for (const variant of model.variants ?? []) {
      const wire = variant.variantStringRepresentation ?? variant.legacySlug
      if (!wire) continue
      add(
        wire,
        variant.displayNameOutsidePicker ??
          variant.displayName ??
          `${cursorModelDisplayName(model)} variant`,
      )
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

  const registerOne = (entry: Parameters<typeof registerCursorModelInto>[1]) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    registerCursorModelInto(models, entry)
    registered.push(entry.id)
  }

  for (const model of decoded.models) {
    if (model.isHidden) continue
    if (!model.name) continue

    const parentCaps = deriveCursorCapabilities(model)
    const parentDisplay = cursorModelDisplayName(model)
    const parentEffortParamId = resolveCursorEffortParamId(model)
    const parentTags = tagsForModel(model, [], { effortParamId: parentEffortParamId })

    registerOne({
      id: cursorHostModelId(model.name),
      wireId: model.name,
      displayName: parentDisplay,
      capabilities: parentCaps,
      tags: parentTags,
    })

    // Aliases / legacy slugs: separate host ids with parent caps (not registry aliases).
    // Prefer canonical `model.name` when an alias host id would collide with it
    // (registerOne de-dupes); tags mark alias rows for dispatch diagnostics.
    for (const alias of unique([...(model.idAliases ?? []), ...(model.legacySlugs ?? [])])) {
      if (!alias || alias === model.name) continue
      const aliasHostId = cursorHostModelId(alias)
      // Skip if alias maps to the same host id as the canonical name.
      if (aliasHostId === cursorHostModelId(model.name)) continue
      registerOne({
        id: aliasHostId,
        wireId: alias,
        displayName: parentDisplay,
        capabilities: parentCaps,
        tags: tagsForModel(model, ["alias", `canonical:${model.name}`], {
          effortParamId: parentEffortParamId,
        }),
      })
    }

    for (const variant of model.variants ?? []) {
      const hasVariantString = Boolean(variant.variantStringRepresentation)
      const wire = variant.variantStringRepresentation ?? variant.legacySlug
      if (!wire) continue
      // Tag contract for Jack RequestedModel encode:
      // - `variant` — diagnostic: exploded variant row (any wire source)
      // - `variant-string` — wire came from variantStringRepresentation → f8
      //   is_variant_string_representation (NOT for legacySlug-only rows)
      // - `max-mode` — selected max only (variant.isMaxMode)
      // Prefer variant-local effort param id when present, else parent field 29.
      const variantEffortParamId = resolveCursorEffortParamId(model, variant) ?? parentEffortParamId
      const vTags = tagsForModel(
        model,
        [
          "variant",
          ...(hasVariantString
            ? (["variant-string"] as const)
            : (["variant-legacy-slug"] as const)),
          `parent:${model.name}`,
          ...(variant.isMaxMode ? ["max-mode"] : []),
          ...(variant.isDefaultMaxConfig ? ["default-max"] : []),
          ...(variant.isDefaultNonMaxConfig ? ["default-non-max"] : []),
        ],
        { effortParamId: variantEffortParamId },
      )
      registerOne({
        id: cursorHostModelId(wire),
        wireId: wire,
        displayName:
          variant.displayNameOutsidePicker ?? variant.displayName ?? `${parentDisplay} variant`,
        capabilities: deriveCursorVariantCapabilities(model, variant),
        tags: vTags,
      })
    }
  }

  // Legacy flat model_names without a rich AvailableModel message.
  for (const modelName of decoded.modelNames) {
    if (!modelName) continue
    const id = cursorHostModelId(modelName)
    if (seen.has(id)) continue
    registerOne({
      id,
      wireId: modelName.replace(/^cursor-/, ""),
      displayName: modelName,
      capabilities: deriveCursorCapabilities({ name: modelName }),
      tags: ["cursor", "live", "legacy-name"],
    })
  }

  return registered
}

/** Optional registrar capture for list-time enrichment (set by adapter bootstrap). */
let liveRegistrar: ModelRegistrar | undefined

/** Wire the host model registrar so live catalog can publish full ModelEntry caps. */
export function setCursorLiveModelRegistrar(models: ModelRegistrar | undefined): void {
  liveRegistrar = models
}

/** Read back the registrar (tests). */
export function getCursorLiveModelRegistrar(): ModelRegistrar | undefined {
  return liveRegistrar
}

/**
 * Authenticated AvailableModels catalog.
 * Best effort: failure returns [] for static fallback.
 * On success, also registers full capability entries when a registrar is set.
 */
export async function listCursorLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  try {
    const ids = await loadClientIds()
    const token = await resolveCursorAccessToken(auth)
    const response = await fetch(availableModelsUrl(), {
      method: "POST",
      headers: buildCursorHeaders({ token, ids, streaming: false, clientType: "ide" }),
      body: new Uint8Array(0),
    })
    if (!response.ok) {
      // Soft-fail so multi-provider list-models still shows static Cursor seed.
      // Prefix makes Cursor failures attributable vs Anthropic "Models API 401".
      if (response.status === 401 || response.status === 403) {
        // Swallow — host Promise.allSettled only prints thrown errors. Cursor
        // stays quiet; other providers own their own throw shapes.
      }
      return []
    }
    const body = new Uint8Array(await response.arrayBuffer())
    const decoded = decodeAvailableModelsResponse(body)
    if (liveRegistrar) {
      try {
        registerCursorLiveCatalog(liveRegistrar, decoded)
      } catch {
        // Registration must not break the live row list.
      }
    }
    return mapCursorLiveModels(decoded)
  } catch {
    return []
  }
}
