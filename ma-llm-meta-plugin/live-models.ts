/**
 * Meta Model API live model catalog (`GET /v1/models`).
 *
 * @module llm/providers/meta/live-models
 */

import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow } from "./lib/provider-plugin.ts"
import { MODELS_URL } from "./wire-constants.ts"

interface OpenAIModelRow {
  id?: string
  created?: number
  owned_by?: string
}

interface OpenAIModelsResponse {
  data?: OpenAIModelRow[]
}

function bearerToken(auth: ProviderAuth): string | null {
  if (auth.kind === "api-key") return auth.key || null
  if (auth.kind === "oauth") return auth.token || null
  return null
}

/**
 * Fetch live Meta models. Resolves `[]` when unauthenticated or on any
 * non-2xx / parse failure so `--list-models` can fall back to the static catalog.
 */
export async function listMetaLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  const token = bearerToken(auth)
  if (!token) return []
  let resp: Response
  try {
    resp = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    })
  } catch {
    return []
  }
  if (!resp.ok) return []
  let body: OpenAIModelsResponse
  try {
    body = (await resp.json()) as OpenAIModelsResponse
  } catch {
    return []
  }
  const out: LiveModelRow[] = []
  for (const row of body.data ?? []) {
    if (!row.id) continue
    const createdAt =
      typeof row.created === "number" && row.created > 0
        ? new Date(row.created * 1000).toISOString().slice(0, 10)
        : undefined
    out.push({ id: row.id, createdAt })
  }
  return out
}
