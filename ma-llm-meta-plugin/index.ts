/**
 * Public surface for the Meta Model API provider (OpenAI-compatible).
 *
 * @module llm/providers/meta
 */

export {
  bootstrapMeta,
  metaAdapter,
  metaProviderPlugin,
  registerMetaAdHocModel,
} from "./adapter.ts"
export {
  buildMetaApiKeyCredential,
  buildMuseOAuthCredential,
  META_API_KEY_AUTH,
  META_MUSE_OAUTH,
  metaApiKeyAuth,
  metaApiKeyToSecrets,
  mintMuseApiKey,
  museOAuthLogin,
  museOAuthToSecrets,
  readMetaApiKey,
  readMuseOAuthAuth,
} from "./auth.ts"
export {
  CAPS_MUSE_SPARK_1_1,
  CAPS_MUSE_SPARK_1_2,
  CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
} from "./capabilities.ts"
export { listMetaLiveModels } from "./live-models.ts"
export {
  findMetaModelByTags,
  listMetaBuiltinModelIds,
  META_DEFAULT_MODEL_ID,
  metaContextWindow,
  metaModelShortLabel,
  registerMetaModel,
  registerMetaModels,
} from "./models.ts"
export {
  PRICING_META_GENERIC,
  PRICING_MUSE_SPARK_1_1,
  PRICING_MUSE_SPARK_1_2,
  PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
} from "./pricing.ts"
export {
  accumulateMetaUsage,
  clearMetaRateLimits,
  fetchMetaSessionInfo,
  getMetaRateLimits,
  parseMetaQuotaWindows,
  primeMetaSessionInfo,
  setMetaRateLimits,
} from "./session-info.ts"
export {
  CHAT_COMPLETIONS_URL,
  MESSAGES_URL,
  META_API_BASE_URL,
  META_DEV_CONSOLE_URL,
  META_DOCS_URL,
  META_OPENAI_BASE,
  META_USER_AGENT,
  MODELS_URL,
  MUSE_API_VERSION,
  MUSE_AUTH_BASE_URL,
  MUSE_CLIENT_ID,
  MUSE_CLIENT_ID_HEADER,
  MUSE_DEVICE_AUTHORIZATION_URL,
  MUSE_DEVICE_CODE_GRANT,
  MUSE_DEVICE_TOKEN_URL,
  MUSE_KEY_MINT_URL,
  MUSE_OAUTH_USER_AGENT,
  RESPONSES_URL,
} from "./wire-constants.ts"
