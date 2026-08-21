/** OpenCode Zen model registry. */
import { CAPS_OPENCODE_ZEN_CHAT_FALLBACK, CAPS_OX_ALPHA_FREE } from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { SurfaceId } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import { PRICING_OPENCODE_ZEN_GENERIC, PRICING_OX_ALPHA_FREE } from "./pricing.ts"

const estimateTokens = makeCharRatioEstimator(3.8)

interface ZenModelSpec extends ProviderModelSpec {
  surfaceId: SurfaceId
}

function makeSpec(
  id: string,
  displayName: string,
  capabilities: Capabilities,
  pricing: ZenModelSpec["pricing"],
  tags: string[],
): ZenModelSpec {
  return {
    id,
    providerId: "opencode-zen",
    surfaceId: "openai-chat-completions",
    displayName,
    tags,
    capabilities,
    estimateTokens,
    pricing,
    vendorIds: { firstParty: id },
  }
}

const BUILTIN_MODELS: ZenModelSpec[] = [
  makeSpec("x-preview-f-free", "Ox Alpha Free", CAPS_OX_ALPHA_FREE, PRICING_OX_ALPHA_FREE, [
    "opencode-zen",
    "openai-compatible",
    "free",
    "cheap",
  ]),
]

/** Register the built-in OpenCode Zen model catalog. */
export function registerOpencodeZenModels(registrar: ModelRegistrar): string[] {
  for (const model of BUILTIN_MODELS) registrar.register(model)
  return BUILTIN_MODELS.map((model) => model.id)
}

/** Register one OpenCode Zen model with fallback metadata. */
export function registerOpencodeZenModelInto(registrar: ModelRegistrar, modelId: string): string {
  registrar.register(
    makeSpec(modelId, modelId, CAPS_OPENCODE_ZEN_CHAT_FALLBACK, PRICING_OPENCODE_ZEN_GENERIC, [
      "opencode-zen",
      "openai-compatible",
    ]),
  )
  return modelId
}
