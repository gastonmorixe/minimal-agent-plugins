/**
 * DeepSeek API-key auth strategy.
 *
 * @module llm/providers/deepseek/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "./lib/provider-plugin.ts"

export const DEEPSEEK_API_KEY_AUTH = {
  serviceId: "deepseek-api-key",
  displayName: "DeepSeek API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode a DeepSeek API key into this provider's opaque secret bag. */
export function deepseekApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a DeepSeek API key. */
export function buildDeepseekApiKeyCredential(apiKey: string) {
  return {
    serviceId: DEEPSEEK_API_KEY_AUTH.serviceId,
    displayName: DEEPSEEK_API_KEY_AUTH.displayName,
    secrets: deepseekApiKeyToSecrets(apiKey),
  }
}

/** Decode a DeepSeek API key from this provider's opaque secret bag. */
export function readDeepseekApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored DeepSeek API-key metadata without exposing the secret. */
export function inspectDeepseekApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readDeepseekApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const deepseekApiKeyAuth: ApiKeyAuthProvider = {
  ...DEEPSEEK_API_KEY_AUTH,
  buildCredential: buildDeepseekApiKeyCredential,
  readApiKey: readDeepseekApiKey,
  inspectCredential: inspectDeepseekApiKeyCredential,
}
