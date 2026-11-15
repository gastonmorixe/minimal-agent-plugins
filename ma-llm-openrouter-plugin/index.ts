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
export {
  CAPS_OPENROUTER_CHAT,
  CAPS_OR_CLAUDE_OPUS_55,
  CAPS_OR_CLAUDE_SONNET_55,
  CAPS_OR_DEEPSEEK_V41_FLASH,
  CAPS_OR_GPT_4O_MINI,
  CAPS_OR_GPT_61_SOL,
  CAPS_OR_GROK_47,
  CAPS_OR_KIMI_K31_PRO,
} from "./capabilities.ts"
export {
  findOpenRouterModelByTags,
  registerOpenRouterModelInto,
  registerOpenRouterModels,
} from "./models.ts"
export {
  PRICING_OR_CLAUDE_OPUS_55,
  PRICING_OR_CLAUDE_SONNET_55,
  PRICING_OR_DEEPSEEK_V41_FLASH,
  PRICING_OR_GENERIC,
  PRICING_OR_GPT_4O_MINI,
  PRICING_OR_GPT_61_SOL,
  PRICING_OR_GROK_47,
  PRICING_OR_KIMI_K27_CODE,
  PRICING_OR_KIMI_K31_PRO,
} from "./pricing.ts"
