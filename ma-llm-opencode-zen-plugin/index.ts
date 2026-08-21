/** Public surface for the OpenCode Zen provider. */
export {
  bootstrapOpencodeZen,
  OPENCODE_ZEN_CHAT_URL,
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
export { registerOpencodeZenModelInto, registerOpencodeZenModels } from "./models.ts"
export { PRICING_OPENCODE_ZEN_GENERIC, PRICING_OX_ALPHA_FREE } from "./pricing.ts"
