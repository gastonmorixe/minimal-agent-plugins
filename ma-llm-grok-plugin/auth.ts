/**
 * Grok / xAI API-key auth strategy.
 *
 * OAuth lives in `./oauth-login.ts` (device-code PIN + refresh).
 *
 * @module llm/providers/grok/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "./lib/provider-plugin.ts"

export const GROK_API_KEY_AUTH = {
  serviceId: "grok-api-key",
  displayName: "Grok / xAI API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

export function grokApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

export function buildGrokApiKeyCredential(apiKey: string) {
  return {
    serviceId: GROK_API_KEY_AUTH.serviceId,
    displayName: GROK_API_KEY_AUTH.displayName,
    secrets: grokApiKeyToSecrets(apiKey),
  }
}

export function readGrokApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

export function inspectGrokApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readGrokApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const grokApiKeyAuth: ApiKeyAuthProvider = {
  ...GROK_API_KEY_AUTH,
  buildCredential: buildGrokApiKeyCredential,
  readApiKey: readGrokApiKey,
  inspectCredential: inspectGrokApiKeyCredential,
}

// Re-export OAuth surface from oauth-login for a single auth entrypoint.
export {
  buildGrokOAuthCredential,
  GROK_OAUTH,
  grokOAuthLogin,
  readGrokOAuthAuth,
  refreshGrokOAuthCredential,
} from "./oauth-login.ts"
