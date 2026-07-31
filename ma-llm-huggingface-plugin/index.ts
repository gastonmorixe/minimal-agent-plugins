/**
 * Public surface for the HuggingFace Inference Providers plugin.
 *
 * @module llm/providers/huggingface
 */

export {
  bootstrapHuggingFace,
  huggingfaceAdapter,
  huggingfaceProviderPlugin,
  registerHuggingFaceAdHocModel,
} from "./adapter.ts"
export {
  buildHuggingfaceApiKeyCredential,
  HUGGINGFACE_API_KEY_AUTH,
  huggingfaceApiKeyAuth,
  huggingfaceApiKeyToSecrets,
  readHuggingfaceApiKey,
} from "./auth.ts"
export {
  CAPS_HUGGINGFACE_CHAT,
  deriveHuggingFaceCapabilities,
  type HuggingFaceModelCapabilityInfo,
  type HuggingFaceProviderEntry,
} from "./capabilities.ts"
export {
  epochToIsoDate,
  listHuggingFaceLiveModels,
  mapHuggingFaceLiveModels,
} from "./live-models.ts"
export {
  findHuggingFaceModelByTags,
  registerHuggingFaceModelInto,
  registerHuggingFaceModels,
} from "./models.ts"
export {
  PRICING_HF_DEEPSEEK_V4_FLASH,
  PRICING_HF_DEEPSEEK_V4_PRO,
  PRICING_HF_GENERIC,
  PRICING_HF_GLM_5_2,
  PRICING_HF_GPT_OSS_20B,
  PRICING_HF_GPT_OSS_120B,
  PRICING_HF_KIMI_K2_7_CODE,
  PRICING_HF_KIMI_K3,
  PRICING_HF_MINIMAX_M3,
} from "./pricing.ts"
export {
  CHAT_COMPLETIONS_URL,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_USER_AGENT,
} from "./wire-constants.ts"
