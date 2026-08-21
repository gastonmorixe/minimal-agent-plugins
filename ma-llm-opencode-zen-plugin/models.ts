/** OpenCode Zen's complete live model registry. */
import {
  CAPS_CHAT,
  CAPS_CLAUDE,
  CAPS_FREE,
  CAPS_GEMINI,
  CAPS_GPT,
  CAPS_GROK,
  CAPS_MESSAGES,
  CAPS_MUSE,
  CAPS_OPENCODE_ZEN_CHAT_FALLBACK,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { SurfaceId } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import { PRICING_OPENCODE_ZEN_GENERIC, PRICING_OX_ALPHA_FREE, ZEN_PRICING } from "./pricing.ts"

const estimateTokens = makeCharRatioEstimator(3.8)
interface ZenModelSpec extends ProviderModelSpec {
  surfaceId: SurfaceId
}

type Family = "claude" | "gemini" | "gpt" | "grok" | "muse" | "chat" | "messages" | "free"
const familyFor = (id: string): Family => {
  if (id.startsWith("claude-")) return "claude"
  if (id.startsWith("gemini-")) return "gemini"
  if (id.startsWith("gpt-")) return "gpt"
  if (id.startsWith("grok-")) return "grok"
  if (id.startsWith("muse-")) return "muse"
  if (id.endsWith("-free") || id === "big-pickle" || id === "x-preview-f-free") return "free"
  if (id.startsWith("qwen")) return "messages"
  return "chat"
}
const surfaceFor = (family: Family): SurfaceId => {
  if (family === "claude" || family === "messages") return "anthropic-messages"
  if (family === "gpt" || family === "grok" || family === "muse") return "openai-responses"
  return "openai-chat-completions"
}
const capsFor = (family: Family): Capabilities =>
  ({
    claude: CAPS_CLAUDE,
    gemini: CAPS_GEMINI,
    gpt: CAPS_GPT,
    grok: CAPS_GROK,
    muse: CAPS_MUSE,
    chat: CAPS_CHAT,
    messages: CAPS_MESSAGES,
    free: CAPS_FREE,
  })[family]

const LIVE_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "grok-build-0.1",
  "grok-4.6",
  "grok-4.5",
  "muse-spark-1.2",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "big-pickle",
  "deepseek-v4-flash-free",
  "x-preview-f-free",
  "muse-spark-1.2-contributor-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "laguna-s-2.1-free",
] as const

function makeSpec(id: string): ZenModelSpec {
  const family = familyFor(id)
  const surfaceId = surfaceFor(family)
  const displayName = id
    .replace(/(^|-)([a-z])/g, (_, sep, c) => `${sep}${c.toUpperCase()}`)
    .replace(/-/g, " ")
  return {
    id,
    providerId: "opencode-zen",
    surfaceId,
    displayName,
    tags: ["opencode-zen", surfaceId, family, ...(family === "free" ? ["free", "cheap"] : [])],
    capabilities: capsFor(family),
    estimateTokens,
    pricing:
      ZEN_PRICING[id] ?? (family === "free" ? PRICING_OX_ALPHA_FREE : PRICING_OPENCODE_ZEN_GENERIC),
    vendorIds: { firstParty: id },
  }
}

const BUILTIN_MODELS = LIVE_MODEL_IDS.map(makeSpec)

/** Register all models from the live OpenCode Zen catalog snapshot. */
export function registerOpencodeZenModels(registrar: ModelRegistrar): string[] {
  for (const model of BUILTIN_MODELS) registrar.register(model)
  return [...LIVE_MODEL_IDS]
}
/** Register one ad-hoc Zen model with conservative fallback capabilities. */
export function registerOpencodeZenModelInto(registrar: ModelRegistrar, modelId: string): string {
  registrar.register({ ...makeSpec(modelId), capabilities: CAPS_OPENCODE_ZEN_CHAT_FALLBACK })
  return modelId
}
export { LIVE_MODEL_IDS }
