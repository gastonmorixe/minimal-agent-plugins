/**
 * Live model catalog from xAI / cli-chat-proxy `GET /v1/models` (+ `/models-v2`).
 *
 * The OAuth path prefers `/models-v2`, which carries the full per-model
 * config (supported_in_api, hidden, agent_type, laziness_detector) that the
 * plain `/models` payload omits. Verified 2026-08-21: both serve
 * grok-4.6 + grok-4.5 with identical core fields.
 *
 * @module llm/providers/grok/live-models
 */

import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { LiveModelRow } from "./lib/provider-plugin.ts"
import { CLI_MODELS_URL, CLI_MODELS_V2_URL, MODELS_URL } from "./wire-constants.ts"

interface GrokModelRow {
  id?: string
  model?: string
  name?: string
  object?: string
  created?: number
  context_window?: number
  api_backend?: string
  reasoning_effort?: string
  supports_reasoning_effort?: boolean
  hidden?: boolean
  supported_in_api?: boolean
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

function modelsUrls(auth: ProviderAuth): string[] {
  if (auth.kind === "oauth") return [CLI_MODELS_V2_URL, CLI_MODELS_URL]
  return [MODELS_URL]
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
    headers["x-grok-client-version"] = "1.0.5"
    headers["x-grok-client-identifier"] = "grok-shell"
  }

  for (const url of modelsUrls(auth)) {
    let resp: Response
    try {
      resp = await fetch(url, { headers })
    } catch {
      return []
    }
    if (!resp.ok) continue

    let body: GrokModelsResponse
    try {
      body = (await resp.json()) as GrokModelsResponse
    } catch {
      continue
    }

    const rows: LiveModelRow[] = []
    for (const row of body.data ?? []) {
      const id = row.id ?? row.model
      if (!id) continue
      // Skip server-hidden SKUs unless they are the only thing listed.
      if (row.hidden === true && (body.data?.length ?? 0) > 1) continue
      rows.push({
        id,
        displayName: row.name ?? id,
        createdAt:
          typeof row.created === "number"
            ? new Date(row.created * 1000).toISOString().slice(0, 10)
            : undefined,
      })
    }
    if (rows.length > 0) return rows
  }
  return []
}
