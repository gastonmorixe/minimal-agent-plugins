/**
 * Request headers for Grok / xAI.
 *
 * API-key path: standard OpenAI Bearer headers.
 * OAuth/session path (cli-chat-proxy): add X-XAI-Token-Auth + model override.
 *
 * @module llm/providers/grok/headers
 */

import { buildOpenAIHeaders } from "./lib/openai-chat.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import {
  GROK_AGENT_ID_HEADER,
  GROK_AUTO_COMPACT_THRESHOLD_PERCENT,
  GROK_CLIENT_MODE_HEADER,
  GROK_COMPACTION_AT_HEADER,
  GROK_COMPACTIONS_REMAINING,
  GROK_COMPACTIONS_REMAINING_HEADER,
  GROK_CONV_ID_HEADER,
  GROK_MODEL_OVERRIDE_HEADER,
  GROK_REQ_ID_HEADER,
  GROK_SESSION_ID_HEADER,
  GROK_USER_AGENT,
  grokCliProxyIdentityHeaders,
} from "./wire-constants.ts"

export interface GrokHeadersOpts {
  auth: ProviderAuth
  /** Wire model id for x-grok-model-override (session/proxy only). */
  modelId?: string
  /** Host session id: reused as x-grok-session-id and x-grok-conv-id. */
  sessionId?: string
  /** Model context window. Used to compute x-compaction-at (80% threshold). */
  contextWindow?: number
  /** grok-build sends `interactive` or `headless`. Default interactive. */
  clientMode?: "interactive" | "headless"
}

/** Process-level agent id. grok-build sends this on every inference request. */
const processAgentId = crypto.randomUUID()

/**
 * Build outbound headers for a Grok request.
 * Always sets a Grok-specific User-Agent.
 */
export function buildGrokHeaders(opts: GrokHeadersOpts): Record<string, string> {
  const headers = buildOpenAIHeaders({ auth: opts.auth })
  headers["user-agent"] = GROK_USER_AGENT

  // cli-chat-proxy session tokens need the CLI auth middleware tag.
  if (opts.auth.kind === "oauth") {
    Object.assign(headers, grokCliProxyIdentityHeaders())
    if (opts.modelId) {
      headers[GROK_MODEL_OVERRIDE_HEADER] = opts.modelId
    }
    const sessionId = opts.sessionId?.trim()
    if (sessionId) {
      headers[GROK_SESSION_ID_HEADER] = sessionId
      headers[GROK_CONV_ID_HEADER] = sessionId
    }
    headers[GROK_REQ_ID_HEADER] = crypto.randomUUID()
    headers[GROK_AGENT_ID_HEADER] = processAgentId
    headers[GROK_CLIENT_MODE_HEADER] = opts.clientMode ?? "interactive"
    headers[GROK_COMPACTIONS_REMAINING_HEADER] = GROK_COMPACTIONS_REMAINING
    if (opts.contextWindow && opts.contextWindow > 0) {
      headers[GROK_COMPACTION_AT_HEADER] = String(
        Math.floor((opts.contextWindow * GROK_AUTO_COMPACT_THRESHOLD_PERCENT) / 100),
      )
    }
    // Optional extra headers from the auth bag (e.g. custom client id)
    if (opts.auth.headers) {
      for (const [k, v] of Object.entries(opts.auth.headers)) {
        headers[k] = v
      }
    }
  }

  return headers
}
