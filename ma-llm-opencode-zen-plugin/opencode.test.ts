import { describe, expect, it } from "bun:test"

import { bootstrapOpencodeZen, OPENCODE_ZEN_CHAT_URL, opencodeProviderPlugin } from "./adapter.ts"
import {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  readOpencodeApiKey,
} from "./auth.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

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
    const credential = buildOpencodeApiKeyCredential("zen-test-key")
    expect(readOpencodeApiKey(credential.secrets)).toBe("zen-test-key")
  })

  it("registers Ox Alpha Free on the Chat surface", () => {
    const reg = setup()
    const model = reg.resolveModel("x-preview-f-free")
    expect(model.providerId).toBe("opencode-zen")
    expect(model.displayName).toBe("Ox Alpha Free")
    expect(model.surfaceId).toBe("openai-chat-completions")
    expect(model.capabilities.contextWindow).toBe(1_000_000)
    expect(model.capabilities.maxOutputTokens).toBe(131_072)
    expect(model.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: false,
      video: true,
    })
    expect([...model.capabilities.effort.levels]).toEqual(["low", "high", "max"])
    expect(model.pricing?.inputUSD).toBe(0)
    expect(model.pricing?.outputUSD).toBe(0)
  })

  it("validates a Chat request and uses the Zen endpoint", () => {
    const reg = setup()
    const model = reg.resolveModel("x-preview-f-free")
    const request: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("hello")],
    }
    expect(reg.resolveProvider("opencode-zen").validate(request, model).ok).toBe(true)
    expect(OPENCODE_ZEN_CHAT_URL).toBe("https://opencode.ai/zen/v1/chat/completions")
  })
})
