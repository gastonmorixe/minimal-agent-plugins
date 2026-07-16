/**
 * Public surface for the OpenRouter provider (OpenAI-compatible gateway).
 *
 * @module llm/providers/openrouter
 */

export { bootstrapOpenRouter, openrouterAdapter, openrouterProviderPlugin } from "./adapter.ts"
export {
  buildOpenRouterApiKeyCredential,
  OPENROUTER_API_KEY_AUTH,
  openRouterApiKeyAuth,
  openRouterApiKeyToSecrets,
  readOpenRouterApiKey,
} from "./auth.ts"
export { CAPS_OPENROUTER_CHAT } from "./capabilities.ts"
export {
  findOpenRouterModelByTags,
  registerOpenRouterModelInto,
  registerOpenRouterModels,
} from "./models.ts"
export {
  PRICING_OR_CLAUDE_SONNET_5,
  PRICING_OR_DEEPSEEK_V4_FLASH,
  PRICING_OR_GENERIC,
  PRICING_OR_GPT_4O_MINI,
  PRICING_OR_GPT_56_SOL,
  PRICING_OR_GROK_45,
  PRICING_OR_KIMI_K27_CODE,
  PRICING_OR_KIMI_K3,
} from "./pricing.ts"
