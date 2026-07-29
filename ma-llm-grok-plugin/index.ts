/**
 * Public surface for the Grok (xAI) provider.
 *
 * @module llm/providers/grok
 */

export {
  bootstrapGrok,
  grokAdapter,
  grokProviderPlugin,
  registerGrokAdHocModel,
} from "./adapter.ts"
export {
  buildGrokApiKeyCredential,
  buildGrokOAuthCredential,
  GROK_API_KEY_AUTH,
  GROK_OAUTH,
  grokApiKeyAuth,
  grokApiKeyToSecrets,
  grokOAuthLogin,
  readGrokApiKey,
  readGrokOAuthAuth,
  refreshGrokOAuthCredential,
} from "./auth.ts"
export {
  CAPS_GROK_420_MULTI_AGENT,
  CAPS_GROK_420_NON_REASONING,
  CAPS_GROK_43_CHAT,
  CAPS_GROK_43_RESPONSES,
  CAPS_GROK_45,
  CAPS_GROK_45_CHAT,
  CAPS_GROK_45_RESPONSES,
  CAPS_GROK_BUILD,
  CAPS_GROK_BUILD_CHAT,
  CAPS_GROK_BUILD_RESPONSES,
  CAPS_GROK_GENERIC,
} from "./capabilities.ts"
export { buildGrokHeaders } from "./headers.ts"
export {
  findGrokModelByTags,
  grokContextWindow,
  grokModelShortLabel,
  registerGrokModel,
  registerGrokModels,
} from "./models.ts"
export {
  GROK_OIDC_CLIENT_ID,
  GROK_OIDC_ISSUER,
  GROK_OIDC_SCOPES,
  grokOAuthConfig,
} from "./oauth-login.ts"
export {
  PRICING_GROK_420,
  PRICING_GROK_43,
  PRICING_GROK_45,
  PRICING_GROK_BUILD,
  PRICING_GROK_GENERIC,
} from "./pricing.ts"
export {
  accumulateGrokUsage,
  clearGrokSessionCaches,
  fetchGrokSessionInfo,
  getGrokBillingQuota,
  getGrokRateLimits,
  getGrokSessionUsage,
  parseGrokQuotaWindows,
  primeGrokSessionInfo,
  readGrokOAuthTokenFromAuthStore,
  refreshGrokBillingQuota,
  refreshGrokBillingQuotaViaFetch,
  setGrokBillingQuota,
  setGrokRateLimits,
} from "./session-info.ts"
export { grokChatCompletionsCodec } from "./surface-codecs.ts"
export { validateOpenAIRequest as validateGrokRequest } from "./validate.ts"
export {
  CHAT_COMPLETIONS_URL,
  CLI_BILLING_URL,
  CLI_CHAT_COMPLETIONS_URL,
  CLI_MODELS_URL,
  CLI_RESPONSES_URL,
  GROK_API_BASE_URL,
  GROK_USER_AGENT,
  MODELS_URL,
  RESPONSES_URL,
} from "./wire-constants.ts"
