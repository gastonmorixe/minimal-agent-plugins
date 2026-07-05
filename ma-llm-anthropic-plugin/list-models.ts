/**
 * Anthropic live model catalog: `GET /v1/models?beta=true`, plus the
 * synthesized client-side `[1m]` context-window variants.
 *
 * Owned by the plugin because both the endpoint and the `[1m]` family
 * knowledge are Anthropic-specific. The adapter's `listLiveModels` hook maps
 * the result into the neutral `LiveModelRow` shape the host consumes.
 *
 * @module llm-anthropic/list-models
 */

import { buildAnthropicHeaders } from "./headers.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { AuthResult, ModelEntry } from "./lib/host-types.ts"
import { findModel } from "./lib/registry.ts"

/** One model row as the models endpoint reports it. */
export interface AnthropicModelInfo {
  id: string
  display_name?: string
  type?: string
  created_at?: string
}

const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"

/**
 * The model families that support the 1M context window (as of 2026-06-30):
 * Sonnet 4 / 4.5 / 4.6, Sonnet 5; Opus 4.6 / 4.7 / 4.8 (gated explicitly to
 * avoid the 200k opus-4-0/4-1 ids); Fable 5 (1M-native).
 */
function supports1M(id: string): boolean {
  return (
    id.includes("claude-sonnet-4") ||
    id.includes("claude-sonnet-5") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4-8") ||
    id.includes("claude-fable-5")
  )
}

/**
 * List models available to the authenticated principal, plus a synthesized
 * `[1m]`-suffixed variant for every 1M-capable model. The suffix is a
 * client-side convention (the API itself has no `[1m]` id); 1M activation
 * happens via a beta capability flag.
 *
 * @param auth - Anthropic credential (OAuth or API key).
 * @returns The model rows plus `[1m]` variants.
 */
export async function listAnthropicModels(auth: AuthResult): Promise<AnthropicModelInfo[]> {
  // A model-list GET carries no real message payload; a minimal canonical
  // request is enough for the header builder to classify it + pick flags.
  const req: CanonicalRequest = {
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
  }
  // The header builder needs a model entry only to read capabilities for beta
  // flag gating. Use the plugin-local catalog entry when registered; otherwise a
  // minimal 1M-capable stub keeps the model-list GET self-contained (this is a
  // cold, off-the-hot-path read, so a slightly generous flag set is harmless).
  const model: ModelEntry =
    findModel("claude-opus-4-8") ??
    ({
      id: "claude-opus-4-8",
      providerId: "anthropic",
      surfaceId: "anthropic-messages",
      displayName: "Claude Opus 4.8",
      capabilities: { contextWindow: 1_000_000 } as ModelEntry["capabilities"],
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    } as ModelEntry)
  const { headers } = buildAnthropicHeaders({
    req,
    model,
    auth:
      auth.type === "oauth"
        ? { kind: "oauth", token: auth.token }
        : { kind: "api-key", key: auth.token },
    sessionId: process.env.MINIMAL_AGENT_SESSION_ID ?? "list-models",
  })

  // Cold, off-the-hot-path read: use global fetch (like the ollama/openrouter
  // live-model listers) so this stays free of any host transport / `src/` import.
  let response: Response
  try {
    response = await fetch(MODELS_URL, { method: "GET", headers })
  } catch (err) {
    throw new Error(
      `Models API request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Models API ${response.status}: ${errorBody}`)
  }

  const data = (await response.json()) as { data: AnthropicModelInfo[] }
  const models = data.data

  const variants: AnthropicModelInfo[] = []
  for (const m of models) {
    if (supports1M(m.id)) {
      variants.push({
        ...m,
        id: `${m.id}[1m]`,
        display_name: m.display_name ? `${m.display_name} (1M context)` : `${m.id} (1M context)`,
      })
    }
  }

  return [...models, ...variants]
}
