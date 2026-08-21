import { describe, expect, it } from "bun:test"

import {
  bootstrapOpencodeZen,
  OPENCODE_ZEN_CHAT_URL,
  OPENCODE_ZEN_MESSAGES_URL,
  OPENCODE_ZEN_RESPONSES_URL,
  opencodeProviderPlugin,
} from "./adapter.ts"
import {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  readOpencodeApiKey,
} from "./auth.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { LIVE_MODEL_IDS } from "./models.ts"

function setup() {
  const reg = makeTestRegistry()
  bootstrapOpencodeZen({ models: reg.models, providers: reg.providers })
  return reg
}

describe("llm-opencode-zen", () => {
  it("exposes distinct provider metadata and API-key auth", () => {
    expect(opencodeProviderPlugin.id).toBe("opencode-zen")
    expect(opencodeProviderPlugin.displayName).toBe("OpenCode Zen")
    expect(opencodeProviderPlugin.shortCode).toBe("oz")
    expect(opencodeProviderPlugin.apiKeyAuth).toBe(opencodeApiKeyAuth)
    expect(OPENCODE_API_KEY_AUTH.serviceId).toBe("opencode-api-key")
    expect(readOpencodeApiKey(buildOpencodeApiKeyCredential("zen-test-key").secrets)).toBe(
      "zen-test-key",
    )
  })

  it("registers every live Zen model with the documented surface", () => {
    const reg = setup()
    expect(LIVE_MODEL_IDS).toHaveLength(64)
    for (const id of LIVE_MODEL_IDS) {
      const model = reg.resolveModel(id)
      expect(model.providerId).toBe("opencode-zen")
      if (id.startsWith("claude-") || id.startsWith("qwen"))
        expect(model.surfaceId).toBe("anthropic-messages")
      else if (id.startsWith("gpt-") || id.startsWith("grok-") || id.startsWith("muse-"))
        expect(model.surfaceId).toBe("openai-responses")
      else if (id.startsWith("gemini-")) expect(model.surfaceId).toBe("openai-chat-completions")
      else expect(model.surfaceId).toBe("openai-chat-completions")
      expect(model.pricing).toBeDefined()
      expect(model.capabilities.contextWindow).toBeGreaterThan(0)
    }
  })

  it("validates a Chat request and exposes all wire endpoints", () => {
    const reg = setup()
    const model = reg.resolveModel("x-preview-f-free")
    const request: CanonicalRequest = { modelId: model.id, messages: [userText("hello")] }
    expect(reg.resolveProvider("opencode-zen").validate(request, model).ok).toBe(true)
    expect(OPENCODE_ZEN_CHAT_URL).toBe("https://opencode.ai/zen/v1/chat/completions")
    expect(OPENCODE_ZEN_MESSAGES_URL).toBe("https://opencode.ai/zen/v1/messages")
    expect(OPENCODE_ZEN_RESPONSES_URL).toBe("https://opencode.ai/zen/v1/responses")
  })
})
