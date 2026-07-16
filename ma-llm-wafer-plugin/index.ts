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
  CAPS_GLM_5_1,
  CAPS_GLM_5_2,
  CAPS_GLM_5_2_FAST,
  CAPS_KIMI_K2_6,
  CAPS_MINIMAX_M3,
  CAPS_QWEN3_5_397B,
} from "./capabilities.ts"
export {
  findWaferModelByTags,
  registerWaferModel,
  registerWaferModels,
  waferContextWindow,
  waferModelShortLabel,
} from "./models.ts"
export {
  PRICING_GLM_5_1,
  PRICING_GLM_5_2,
  PRICING_GLM_5_2_FAST,
  PRICING_KIMI_K2_6,
  PRICING_MINIMAX_M3,
  PRICING_QWEN3_5_397B,
  PRICING_WAFER_GENERIC,
} from "./pricing.ts"
export {
  CHAT_COMPLETIONS_URL,
  MODELS_URL,
  WAFER_BASE_URL,
  WAFER_USER_AGENT,
  WAFER_ZDR_HEADER,
} from "./wire-constants.ts"
