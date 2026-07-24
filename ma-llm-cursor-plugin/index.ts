/**
 * Public surface for the Cursor provider (AgentService/Run connect+proto).
 *
 * Self-contained provider plugin: vendored plugin-api type shims under lib/,
 * no src/ or sibling-plugin imports.
 *
 * @module llm/providers/cursor
 */

export {
  bootstrapCursor,
  cursorAdapter,
  cursorProviderPlugin,
  registerCursorAdHocModel,
} from "./adapter.ts"
export {
  buildCursorApiKeyCredential,
  CURSOR_API_KEY_AUTH,
  cursorApiKeyAuth,
  cursorApiKeyToSecrets,
  exchangeCursorApiKey,
  inspectCursorApiKeyCredential,
  parseCursorTokenPair,
  readCursorApiKey,
  resolveCursorAccessToken,
} from "./auth.ts"
export {
  type CursorCapsOptions,
  cursorCapabilities,
  cursorCaps,
  deriveCursorCapabilities,
} from "./capabilities.ts"
export {
  buildCursorChecksum,
  scrambleTimestampBytes,
  timestampBytes,
} from "./checksum.ts"
export { agentRunUrl, apiBase, availableModelsUrl, getUsableModelsUrl } from "./connect/hosts.ts"
export {
  bearerToken,
  buildCursorHeaders,
  type CursorHeaderOptions,
  resolveCursorBearer,
} from "./headers.ts"
export { buildClientIds, type ClientIds, loadClientIds, sha256Hex, toHex } from "./ids.ts"
export { listCursorLiveModels } from "./live-models.ts"
export {
  registerCursorAdHocModelInto,
  registerCursorModelInto,
  registerCursorModels,
} from "./models.ts"
export {
  buildCursorOAuthCredential,
  CURSOR_OAUTH,
  CURSOR_OAUTH as CURSOR_OAUTH_SERVICE,
  completeCursorLogin,
  createCursorLoginChallenge,
  cursorOAuthLogin,
  cursorOAuthToSecrets,
  cursorPollDelayMs,
  inspectCursorOAuthCredential,
  readCursorOAuthAuth,
} from "./oauth-login.ts"
export { PRICING_CURSOR_GENERIC } from "./pricing.ts"
export { decodeAvailableModelsResponse } from "./proto/models-decode.ts"
export { fetchCursorSessionInfo } from "./session-info.ts"
export { validateCursorRequest } from "./validate.ts"
export {
  CURSOR_AGENT_BASE,
  CURSOR_API_BASE,
  CURSOR_STREAM_CONTENT_TYPE,
  CURSOR_SURFACE_AGENT_RUN,
  CURSOR_UNARY_CONTENT_TYPE,
} from "./wire-constants.ts"
