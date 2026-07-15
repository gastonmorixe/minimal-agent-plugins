/**
 * ClinePass API-key auth strategy.
 *
 * Dashboard keys from app.cline.bot → Account → API Keys, used as
 * `Authorization: Bearer …` against api.cline.bot. OAuth (WorkOS device
 * code) lives in `./oauth-login.ts`.
 *
 * @module llm/providers/clinepass/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "./lib/provider-plugin.ts"

export const CLINEPASS_API_KEY_AUTH = {
  serviceId: "clinepass-api-key",
  displayName: "ClinePass API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode a Cline API key into this provider's opaque secret bag. */
export function clinepassApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a Cline API key. */
export function buildClinepassApiKeyCredential(apiKey: string) {
  return {
    serviceId: CLINEPASS_API_KEY_AUTH.serviceId,
    displayName: CLINEPASS_API_KEY_AUTH.displayName,
    secrets: clinepassApiKeyToSecrets(apiKey),
  }
}

/** Decode a Cline API key from this provider's opaque secret bag. */
export function readClinepassApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored API-key metadata without exposing the secret. */
export function inspectClinepassApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readClinepassApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const clinepassApiKeyAuth: ApiKeyAuthProvider = {
  ...CLINEPASS_API_KEY_AUTH,
  buildCredential: buildClinepassApiKeyCredential,
  readApiKey: readClinepassApiKey,
  inspectCredential: inspectClinepassApiKeyCredential,
}

export {
  buildClinepassOAuthCredential,
  CLINEPASS_OAUTH,
  clinepassOAuthLogin,
  readClinepassOAuthAuth,
  refreshClinepassOAuthCredential,
} from "./oauth-login.ts"
