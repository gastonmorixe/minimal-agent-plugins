/**
 * Public surface for the ClinePass provider (OpenAI-compatible gateway).
 *
 * @module llm/providers/clinepass
 */

export {
  bootstrapClinepass,
  clinepassAdapter,
  clinepassProviderPlugin,
  registerClinepassAdHocModel,
} from "./adapter.ts"
export {
  buildClinepassApiKeyCredential,
  CLINEPASS_API_KEY_AUTH,
  clinepassApiKeyAuth,
  clinepassApiKeyToSecrets,
  readClinepassApiKey,
} from "./auth.ts"
export {
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5_2,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_KIMI_K3,
  CAPS_MIMO_V2_5,
  CAPS_MIMO_V2_5_PRO,
  CAPS_MINIMAX_M3,
  CAPS_QWEN3_7_MAX,
  CAPS_QWEN3_7_PLUS,
} from "./capabilities.ts"
export {
  clinepassContextWindow,
  clinepassModelShortLabel,
  findClinepassModelByTags,
  listClinepassBuiltinModelIds,
  registerClinepassModel,
  registerClinepassModels,
} from "./models.ts"
export {
  buildClinepassOAuthCredential,
  CLINEPASS_OAUTH,
  clinepassOAuthLogin,
  formatClinepassBearerToken,
  readClinepassOAuthAuth,
  refreshClinepassOAuthCredential,
} from "./oauth-login.ts"
export {
  PRICING_CLINEPASS_GENERIC,
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5_2,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_KIMI_K3,
  PRICING_MIMO_V2_5,
  PRICING_MIMO_V2_5_PRO,
  PRICING_MINIMAX_M3,
  PRICING_QWEN3_7_MAX,
  PRICING_QWEN3_7_PLUS,
} from "./pricing.ts"
export {
  CHAT_COMPLETIONS_URL,
  CLINE_API_BASE_URL,
  CLINE_OPENAI_BASE,
  CLINEPASS_SUBSCRIBE_URL,
  CLINEPASS_USER_AGENT,
  MODELS_URL,
} from "./wire-constants.ts"
