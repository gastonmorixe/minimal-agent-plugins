/**
 * Public surface for the Wafer provider (OpenAI-compatible gateway).
 *
 * @module llm/providers/wafer
 */

export {
  bootstrapWafer,
  registerWaferAdHocModel,
  waferAdapter,
  waferProviderPlugin,
} from "./adapter.ts"
export {
  buildWaferApiKeyCredential,
  readWaferApiKey,
  WAFER_API_KEY_AUTH,
  waferApiKeyAuth,
  waferApiKeyToSecrets,
} from "./auth.ts"
export {
  CAPS_DEEPSEEK_V4_1_FLASH,
  CAPS_DEEPSEEK_V4_FLASH_0423,
  CAPS_DEEPSEEK_V4_FLASH_0731_FAST,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5_2,
  CAPS_GLM_5_3,
  CAPS_GLM_5_3_FLASH,
  CAPS_KIMI_K3,
  CAPS_KIMI_K3_1_PRO,
  CAPS_MINIMAX_M3_1_FLASH,
  CAPS_QWEN3_8_27B,
} from "./capabilities.ts"
export {
  findWaferModelByTags,
  registerWaferModel,
  registerWaferModels,
  waferContextWindow,
  waferModelShortLabel,
} from "./models.ts"
export {
  PRICING_DEEPSEEK_V4_1_FLASH,
  PRICING_DEEPSEEK_V4_1_FLASH_1017,
  PRICING_DEEPSEEK_V4_FLASH_0423,
  PRICING_DEEPSEEK_V4_FLASH_0731_FAST,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5_2,
  PRICING_GLM_5_3,
  PRICING_GLM_5_3_FLASH,
  PRICING_KIMI_K3,
  PRICING_KIMI_K3_1_PRO,
  PRICING_MINIMAX_M3_1_FLASH,
  PRICING_QWEN3_8_27B,
  PRICING_WAFER_GENERIC,
} from "./pricing.ts"
export {
  CHAT_COMPLETIONS_URL,
  MODELS_URL,
  WAFER_BASE_URL,
  WAFER_USER_AGENT,
  WAFER_ZDR_HEADER,
} from "./wire-constants.ts"
