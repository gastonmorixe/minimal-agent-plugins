/**
 * Meta Model API key auth strategy.
 *
 * Keys are minted at https://dev.meta.ai/ (format `LLM_…`) and sent as
 * `Authorization: Bearer …`. Official env name is `MODEL_API_KEY`; we also
 * document `META_API_KEY` / `MINIMAL_AGENT_META_API_KEY` for local priming.
 *
 * @module llm/providers/meta/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "./lib/provider-plugin.ts"

export const META_API_KEY_AUTH = {
  serviceId: "meta-api-key",
  displayName: "Meta Model API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode a Meta API key into this provider's opaque secret bag. */
export function metaApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a Meta API key. */
export function buildMetaApiKeyCredential(apiKey: string) {
  return {
    serviceId: META_API_KEY_AUTH.serviceId,
    displayName: META_API_KEY_AUTH.displayName,
    secrets: metaApiKeyToSecrets(apiKey),
  }
}

/** Decode a Meta API key from this provider's opaque secret bag. */
export function readMetaApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored API-key metadata without exposing the secret. */
export function inspectMetaApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readMetaApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const metaApiKeyAuth: ApiKeyAuthProvider = {
  ...META_API_KEY_AUTH,
  buildCredential: buildMetaApiKeyCredential,
  readApiKey: readMetaApiKey,
  inspectCredential: inspectMetaApiKeyCredential,
}
