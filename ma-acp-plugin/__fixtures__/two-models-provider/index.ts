/**
 * Test fixture: a provider plugin that registers two models on the
 * `generic-endpoint` provider, with different context windows. The ACP
 * e2e test puts this dir in a plugin root next to the real plugins. Then
 * the session lists both models and a client can switch between them.
 * The generic-endpoint adapter sends the requests of both models to the
 * mock model server. The request body names the model id.
 *
 * @module __fixtures__/two-models-provider
 */

import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type {
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** The two model ids and their context windows. */
export const TWO_MODELS = [
  { id: "mock-small", contextWindow: 32_000 },
  { id: "mock-big", contextWindow: 64_000 },
] as const

const SURFACE_ID = "openai-chat-completions"

/** Register the two fake models for the ACP test fixture. */
function register(ctx?: ProviderSetupContext): void {
  if (!ctx?.models) return
  // Use the capabilities of the codec when it is already registered, so
  // these models act like the ad-hoc generic-endpoint model.
  const base = ctx.surfaceCodecs?.find(SURFACE_ID)?.defaultCapabilities ?? defaultCapabilities()
  for (const { id, contextWindow } of TWO_MODELS) {
    ctx.models.register({
      id,
      providerId: "generic-endpoint",
      surfaceId: SURFACE_ID,
      displayName: id,
      capabilities: { ...base, contextWindow },
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
      vendorIds: { firstParty: id },
    })
  }
}

export const twoModelsProviderPlugin: ProviderPlugin = {
  id: "acp-two-models-fixture",
  displayName: "ACP two-models fixture",
  shortCode: "fix",
  register,
}
