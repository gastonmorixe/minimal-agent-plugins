/**
 * DeepSeek live model catalog.
 *
 * Implements the data side of `ProviderPlugin.listLiveModels`: a best-effort
 * GET of `https://api.deepseek.com/models` so `--list-models-live` and the REPL
 * model picker show the AUTHORITATIVE server catalog, not just the curated
 * static snapshot in `./models.ts`.
 *
 * Uses the global `fetch` rather than the host transport: listing is a cold,
 * off-the-hot-path read, and keeping it on `fetch` lets this plugin stay free of
 * any `src/` import (mirrors `ma-llm-huggingface-plugin/live-models.ts`). Must
 * resolve `[]` on failure — callers treat an error as "live list unavailable"
 * and fall back to the registry.
 *
 * DeepSeek's `/models` endpoint requires auth (unlike HuggingFace's), so this
 * plugin does NOT set `publicModelList`: an unauthenticated listing skips it.
 *
 * @module llm/providers/deepseek/live-models
 */

import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow } from "./lib/provider-plugin.ts"
import { MODELS_URL } from "./wire-constants.ts"

/** One entry of the `/models` response `data[]` array. */
interface DeepSeekModelRow {
  id?: string
  object?: string
  /** Unix epoch seconds DeepSeek reports for the model, when present. */
  created?: number
  owned_by?: string
}

interface DeepSeekModelsResponse {
  data?: DeepSeekModelRow[]
}

/** Pull the Bearer token from provider auth, or null when not key/oauth. */
function bearerToken(auth: ProviderAuth): string | null {
  if (auth.kind === "api-key") return auth.key || null
  if (auth.kind === "oauth") return auth.token || null
  return null
}

/** Convert a Unix-epoch-seconds timestamp into an ISO `YYYY-MM-DD`, or undefined. */
export function epochToIsoDate(created: number | undefined): string | undefined {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return undefined
  const d = new Date(created * 1000)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10)
}

/**
 * Map a parsed `/models` body into the neutral {@link LiveModelRow}[] shape.
 * Skips rows without an `id`. Pure — no I/O, so it's directly unit-testable.
 */
export function mapDeepSeekLiveModels(body: DeepSeekModelsResponse): LiveModelRow[] {
  const rows = body.data ?? []
  const out: LiveModelRow[] = []
  for (const row of rows) {
    if (!row.id) continue
    out.push({ id: row.id, createdAt: epochToIsoDate(row.created) })
  }
  return out
}

/**
 * Fetch the live DeepSeek model list. Returns rows ready for the listing merge
 * (id + ISO date). Resolves `[]` on any non-2xx / parse failure so a server
 * outage never hides the built-in catalog.
 */
export async function listDeepSeekLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  const token = bearerToken(auth)
  const headers: Record<string, string> = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  let resp: Response
  try {
    resp = await fetch(MODELS_URL, { headers })
  } catch {
    return []
  }
  if (!resp.ok) return []
  let body: DeepSeekModelsResponse
  try {
    body = (await resp.json()) as DeepSeekModelsResponse
  } catch {
    return []
  }
  return mapDeepSeekLiveModels(body)
}
