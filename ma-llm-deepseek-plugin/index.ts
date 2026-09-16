/**
 * Public surface for the DeepSeek provider (OpenAI Chat Completions-compatible).
 *
 * @module llm/providers/deepseek
 */

export {
  bootstrapDeepSeek,
  deepseekAdapter,
  deepseekProviderPlugin,
  registerDeepSeekAdHocModel,
  withDeepSeekReasoningSignature,
} from "./adapter.ts"
export {
  buildDeepseekApiKeyCredential,
  DEEPSEEK_API_KEY_AUTH,
  deepseekApiKeyAuth,
  deepseekApiKeyToSecrets,
  readDeepseekApiKey,
} from "./auth.ts"
export {
  CAPS_DEEPSEEK_CHAT,
  CAPS_DEEPSEEK_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
} from "./capabilities.ts"
export {
  listDeepSeekLiveModels,
  mapDeepSeekLiveModels,
} from "./live-models.ts"
export {
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_SURFACE_ID,
  findDeepSeekModelByTags,
  registerDeepSeekModelInto,
  registerDeepSeekModels,
} from "./models.ts"
export {
  PRICING_DEEPSEEK_FLASH,
  PRICING_DEEPSEEK_GENERIC,
  PRICING_DEEPSEEK_V4_PRO,
} from "./pricing.ts"
export { buildDeepSeekChatBody, type DeepSeekChatRequestBody } from "./request-body.ts"
export { CHAT_COMPLETIONS_URL, DEEPSEEK_BASE_URL, MODELS_URL } from "./wire-constants.ts"
