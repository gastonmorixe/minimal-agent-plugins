/**
 * Public surface of the Google Antigravity provider plugin.
 *
 * The plugin speaks the Cloud Code Assist envelope that the `agy` CLI uses,
 * with a Google OAuth consumer login and no telemetry call.
 *
 * @module llm/providers/antigravity
 */

export {
  antigravityAdapter,
  antigravityProviderPlugin,
  antigravityUserAgent,
  bootstrapAntigravity,
  registerAntigravityAdHocModel,
  requestHasImages,
  wireModelId,
} from "./adapter.ts"
export {
  type AntigravitySecrets,
  agyTokenFilePaths,
  antigravityExpiresAt,
  antigravitySecretsToBag,
  isExpired,
  REFRESH_SKEW_MS,
  readAgyTokenFile,
  readAntigravitySecrets,
} from "./auth.ts"
export {
  CAPS_CLAUDE_VERTEX,
  CAPS_GEMINI_3_FLASH,
  CAPS_GEMINI_4,
  CAPS_GEMINI_4_SMALL_OUT,
  CAPS_GEMINI_FLASH_LITE,
  CAPS_GPT_OSS,
  CAPS_IMAGE_GEN,
  CAPS_TAB,
} from "./capabilities.ts"
export { antigravityInputMimeTypes, antigravityMediaLimits } from "./input-formats.ts"
export {
  antigravityBootstrap,
  type CatalogEntry,
  clearAntigravityLiveModelsCache,
  type FetchModelsResponse,
  fetchAntigravityCatalog,
  fetchQuotaSummary,
  type LoadCodeAssistResponse,
  listAntigravityLiveModels,
  loadCodeAssist,
  type QuotaSummaryBankedReset,
  type QuotaSummaryBankedResetIneligibleReason,
  type QuotaSummaryResponse,
  resolveProject,
} from "./live-models.ts"
export {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_SURFACE_ID,
  antigravityCapabilitiesFor,
  antigravityFamily,
  antigravityModelShortLabel,
  antigravityModelSpecFromCatalog,
  antigravityModelSpecFromSnapshot,
  antigravityModelVersionToken,
  type CatalogModelRow,
  type CatalogSnapshotRow,
  listAntigravityStaticModelIds,
  type ModelFamily,
  registerAntigravityAdHocModelInto,
  registerAntigravityModels,
  thinkingSuffixOf,
} from "./models.ts"
export { PRICING_ANTIGRAVITY_PLAN, PRICING_ANTIGRAVITY_UNKNOWN } from "./pricing.ts"
export { type AntigravityBodyInput, buildAntigravityBody } from "./request-body.ts"
export { sanitizeGeminiSchema } from "./schema-sanitize.ts"
export {
  accumulateAntigravityUsage,
  antigravitySessionInfoFromQuota,
  clearAntigravitySessionUsage,
  fetchAntigravitySessionInfo,
  getAntigravitySessionUsage,
  primeAntigravitySessionInfo,
} from "./session-info.ts"
export { validateAntigravityRequest } from "./validate.ts"
export {
  AGY_TOKEN_FILE_NAME,
  ANTIGRAVITY_API_BASE,
  ANTIGRAVITY_CLI_CHANGELIST,
  ANTIGRAVITY_CLI_VERSION,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_LOOPBACK_PATH,
  ANTIGRAVITY_PASTE_REDIRECT_URI,
  ANTIGRAVITY_REQUEST_USER_AGENT,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_SERVICE_ID,
  ANTIGRAVITY_SUCCESS_URL,
  FETCH_MODELS_PATH,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  LOAD_CODE_ASSIST_PATH,
  QUOTA_PATH,
  REQUEST_TYPE_AGENT,
  STREAM_PATH,
} from "./wire-constants.ts"
