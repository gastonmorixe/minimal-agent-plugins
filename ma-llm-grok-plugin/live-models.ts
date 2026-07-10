/**
 * Live model catalog from xAI / cli-chat-proxy `GET /v1/models`.
 *
 * @module llm/providers/grok/live-models
 */

import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow } from "./lib/provider-plugin.ts"
import { CLI_MODELS_URL, MODELS_URL } from "./wire-constants.ts"

interface GrokModelRow {
  id?: string
  model?: string
  name?: string
  object?: string
  created?: number
  context_window?: number
}

interface GrokModelsResponse {
  data?: GrokModelRow[]
  object?: string
}

function bearerToken(auth: ProviderAuth): string | undefined {
  if (auth.kind === "api-key") return auth.key
  if (auth.kind === "oauth") return auth.token
  return undefined
}

function modelsUrl(auth: ProviderAuth): string {
  if (auth.kind === "oauth") return CLI_MODELS_URL
  return MODELS_URL
}

/**
 * Fetch live models. Returns [] on any failure (host falls back to static catalog).
 */
export async function listGrokLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  const token = bearerToken(auth)
  const headers: Record<string, string> = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  if (auth.kind === "oauth") {
    headers["x-xai-token-auth"] = "xai-grok-cli"
  }

  let resp: Response
  try {
    resp = await fetch(modelsUrl(auth), { headers })
  } catch {
    return []
  }
  if (!resp.ok) return []

  let body: GrokModelsResponse
  try {
    body = (await resp.json()) as GrokModelsResponse
  } catch {
    return []
  }

  const rows: LiveModelRow[] = []
  for (const row of body.data ?? []) {
    const id = row.id ?? row.model
    if (!id) continue
    rows.push({
      id,
      displayName: row.name ?? id,
      createdAt:
        typeof row.created === "number"
          ? new Date(row.created * 1000).toISOString().slice(0, 10)
          : undefined,
    })
  }
  return rows
}
