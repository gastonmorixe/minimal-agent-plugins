import { resolveCursorAccessToken } from "./auth.ts"
import { availableModelsUrl } from "./connect/hosts.ts"
import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow } from "./lib/provider-plugin.ts"
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

/** Expand rich models into host live rows with **namespaced** ids. */
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

/** Authenticated AvailableModels catalog. Best effort: failure returns [] for static fallback. */
export async function listCursorLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  try {
    const ids = await loadClientIds()
    const token = await resolveCursorAccessToken(auth)
    const response = await fetch(availableModelsUrl(), {
      method: "POST",
      headers: buildCursorHeaders({ token, ids, streaming: false, clientType: "ide" }),
      body: new Uint8Array(0),
    })
    if (!response.ok) return []
    const body = new Uint8Array(await response.arrayBuffer())
    return mapCursorLiveModels(decodeAvailableModelsResponse(body))
  } catch {
    return []
  }
}
