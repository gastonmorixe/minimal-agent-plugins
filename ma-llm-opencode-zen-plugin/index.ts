/** Public surface for the OpenCode Zen provider. */
export {
  bootstrapOpencodeZen,
  OPENCODE_ZEN_CHAT_URL,
  OPENCODE_ZEN_MESSAGES_URL,
  OPENCODE_ZEN_RESPONSES_URL,
  opencodeProviderPlugin,
  registerOpencodeZenAdHocModel,
} from "./adapter.ts"
export {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  opencodeApiKeyToSecrets,
  readOpencodeApiKey,
} from "./auth.ts"
export { CAPS_OX_ALPHA_FREE } from "./capabilities.ts"
export {
  LIVE_MODEL_IDS,
  registerOpencodeZenModelInto,
  registerOpencodeZenModels,
} from "./models.ts"
export { PRICING_OPENCODE_ZEN_GENERIC, PRICING_OX_ALPHA_FREE, ZEN_PRICING } from "./pricing.ts"
