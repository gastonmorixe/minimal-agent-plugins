import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "./lib/provider-plugin.ts"

export const OPENCODE_API_KEY_AUTH = {
  serviceId: "opencode-api-key",
  displayName: "OpenCode Zen API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode an OpenCode Zen API key into its opaque secret bag. */
export function opencodeApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable OpenCode Zen credential. */
export function buildOpencodeApiKeyCredential(apiKey: string) {
  return {
    serviceId: OPENCODE_API_KEY_AUTH.serviceId,
    displayName: OPENCODE_API_KEY_AUTH.displayName,
    secrets: opencodeApiKeyToSecrets(apiKey),
  }
}

/** Read the OpenCode Zen API key from the opaque secret bag. */
export function readOpencodeApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored OpenCode Zen credential metadata without exposing the secret. */
export function inspectOpencodeApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readOpencodeApiKey(secrets)
  return { usable: Boolean(apiKey && apiKey.trim().length > 0) }
}

export const opencodeApiKeyAuth: ApiKeyAuthProvider = {
  ...OPENCODE_API_KEY_AUTH,
  buildCredential: buildOpencodeApiKeyCredential,
  readApiKey: readOpencodeApiKey,
  inspectCredential: inspectOpencodeApiKeyCredential,
}
