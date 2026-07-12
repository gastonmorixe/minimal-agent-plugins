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
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_IDENTIFIER_HEADER,
  GROK_CLIENT_VERSION,
  GROK_CLIENT_VERSION_HEADER,
  GROK_MODEL_OVERRIDE_HEADER,
  GROK_USER_AGENT,
  XAI_TOKEN_AUTH_HEADER,
  XAI_TOKEN_AUTH_VALUE,
} from "./wire-constants.ts"

export interface GrokHeadersOpts {
  auth: ProviderAuth
  /** Wire model id for x-grok-model-override (session/proxy only). */
  modelId?: string
}

/**
 * Build outbound headers for a Grok request.
 * Always sets a Grok-specific User-Agent.
 */
export function buildGrokHeaders(opts: GrokHeadersOpts): Record<string, string> {
  const headers = buildOpenAIHeaders({ auth: opts.auth })
  headers["user-agent"] = GROK_USER_AGENT

  // cli-chat-proxy session tokens need the CLI auth middleware tag.
  if (opts.auth.kind === "oauth") {
    headers[XAI_TOKEN_AUTH_HEADER] = XAI_TOKEN_AUTH_VALUE
    headers["x-authenticateresponse"] = "authenticate-response"
    headers[GROK_CLIENT_VERSION_HEADER] = GROK_CLIENT_VERSION
    headers[GROK_CLIENT_IDENTIFIER_HEADER] = GROK_CLIENT_IDENTIFIER
    if (opts.modelId) {
      headers[GROK_MODEL_OVERRIDE_HEADER] = opts.modelId
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
