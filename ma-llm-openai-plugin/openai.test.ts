/**
 * OpenAI provider tests — registry, bootstrap, routing, auth, validation.
 *
 * Stream fixture / modality / service-tier coverage lives in
 * `openai.stream-fixtures.test.ts` (split for max-lines).
 */

import { describe, expect, it } from "bun:test"

import { bootstrapOpenAI, openaiProviderPlugin } from "./adapter.ts"
import {
  buildOpenAIApiKeyCredential,
  OPENAI_API_KEY_AUTH,
  openAIApiKeyAuth,
  openAIOAuthLogin,
  readOpenAIApiKey,
} from "./auth.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerOpenAIModels } from "./models.ts"
import {
  captureOpenAIResponseRequest,
  clearModelRegistry,
  clearProviderRegistry,
  findModel,
  resolveModel,
  resolveProvider,
} from "./openai.test-helpers.ts"

// ---------------------------------------------------------------------------
// Registry + bootstrap
// ---------------------------------------------------------------------------

describe("registerOpenAIModels", () => {
  it("registers gpt-5.6 Sol on the Responses surface with current capability + pricing data", () => {
    const reg = makeTestRegistry()
    const ids = registerOpenAIModels(reg.models)

    expect(ids).toContain("gpt-5.6-sol")
    const m = reg.resolveModel("gpt-5.6")
    expect(m.id).toBe("gpt-5.6-sol")
    expect(m.providerId).toBe("openai")
    expect(m.surfaceId).toBe("openai-responses")
    expect(m.capabilities.contextWindow).toBe(1_050_000)
    expect(m.capabilities.maxOutputTokens).toBe(128_000)
    expect(m.capabilities.effort.levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
    expect(m.capabilities.thinking.visible).toBe(true)
    expect(m.knowledgeCutoff).toBe("2026-02-16")
    expect(m.pricing.inputUSD).toBe(5)
    expect(m.pricing.outputUSD).toBe(30)
    expect(m.pricing.cacheWriteUSD).toBe(6.25)
    expect(m.pricing.cacheReadUSD).toBe(0.5)
  })

  it("registers the gpt-5.6 family tiers and maps Chat aliases to real model ids", () => {
    const reg = makeTestRegistry()
    const ids = registerOpenAIModels(reg.models)

    expect(ids).toEqual(
      expect.arrayContaining([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5-pro",
        "gpt-5.4-pro",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
      ]),
    )
    expect(reg.resolveModel("gpt-5.6-terra").pricing.inputUSD).toBe(2)
    expect(reg.resolveModel("gpt-5.6-terra").pricing.outputUSD).toBe(12)
    expect(reg.resolveModel("gpt-5.6-luna").pricing.inputUSD).toBe(0.2)
    expect(reg.resolveModel("gpt-5.6-luna").pricing.outputUSD).toBe(1.2)

    const chat = reg.resolveModel("gpt-5.6-chat")
    expect(chat.id).toBe("gpt-5.6-sol-chat")
    expect(chat.surfaceId).toBe("openai-chat-completions")
    expect(chat.vendorIds?.firstParty).toBe("gpt-5.6-sol")
    expect(chat.capabilities.thinking.visible).toBe(false)
    expect(chat.capabilities.serverSideHistory).toBe(false)

    const pro = reg.resolveModel("gpt-5.4-pro")
    expect(pro.surfaceId).toBe("openai-responses")
    expect(pro.pricing.inputUSD).toBe(30)
    expect(pro.pricing.outputUSD).toBe(180)
    expect(pro.capabilities.effort.levels).toEqual(["medium", "high", "xhigh"])
  })

  it("keeps gpt-5.5 and gpt-5.5-chat for compatibility", () => {
    const reg = makeTestRegistry()
    registerOpenAIModels(reg.models)

    const responses = reg.resolveModel("gpt-5.5")
    expect(responses.surfaceId).toBe("openai-responses")
    expect(responses.pricing.outputUSD).toBe(30)

    const chat = reg.resolveModel("gpt-5.5-chat")
    expect(chat.surfaceId).toBe("openai-chat-completions")
    expect(chat.vendorIds?.firstParty).toBe("gpt-5.5")
  })

  it("marks every OpenAI model as sharing one context window for input + output", () => {
    // OpenAI validates `input_tokens + max_output_tokens <= context_window`
    // and rejects over-budget requests with `context_length_exceeded`. The
    // agent's output-budget clamp keys off this capability flag, so EVERY
    // OpenAI surface (Chat AND Responses, including the gpt-5.5 flagship
    // that triggered the original incident) must declare it. A missing flag
    // on a Responses table silently disables the clamp for that model.
    const reg = makeTestRegistry()
    const ids = registerOpenAIModels(reg.models)

    for (const id of ids) {
      const m = reg.resolveModel(id)
      expect(
        m.capabilities.outputTokensShareContextWindow,
        `${id} must set outputTokensShareContextWindow`,
      ).toBe(true)
    }
  })
})

describe("bootstrapOpenAI", () => {
  it("registers the adapter with both surfaces and the model catalog", () => {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapOpenAI()

    const adapter = resolveProvider("openai")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("openai-responses")
    expect(findModel("gpt-5.6")?.id).toBe("gpt-5.6-sol")
    expect(findModel("gpt-5.6-chat")?.surfaceId).toBe("openai-chat-completions")
    expect(findModel("gpt-4o")?.surfaceId).toBe("openai-chat-completions")
    expect(findModel("o3")?.surfaceId).toBe("openai-responses")
  })
})

describe("openaiAdapter request routing", () => {
  it("routes OAuth Responses traffic to the Codex backend path and forwards auth metadata", async () => {
    const request = await captureOpenAIResponseRequest(
      {
        kind: "oauth",
        token: "AT",
        baseUrl: "https://chatgpt.com/backend-api/codex/",
        headers: { "ChatGPT-Account-ID": "acct-1" },
      },
      { generation: { maxOutputTokens: 64 } },
    )

    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(request.headers?.authorization).toBe("Bearer AT")
    expect(request.headers?.["ChatGPT-Account-ID"]).toBe("acct-1")
    const body = JSON.parse(String(request.body))
    expect(body.model).toBe("gpt-5.5")
    expect(body.instructions).toBe("")
    expect(body.store).toBe(false)
    expect(body.max_output_tokens).toBeUndefined()
  })

  it("keeps API-key Responses traffic on the public API path", async () => {
    const request = await captureOpenAIResponseRequest(
      { kind: "api-key", key: "sk-test" },
      { generation: { maxOutputTokens: 64 } },
    )

    expect(request.url).toBe("https://api.openai.com/v1/responses")
    expect(request.headers?.authorization).toBe("Bearer sk-test")
    const body = JSON.parse(String(request.body))
    expect(body.model).toBe("gpt-5.5")
    expect(body.instructions).toBe("")
    expect(body.store).toBe(false)
    expect(body.max_output_tokens).toBe(64)
  })

  it("drops previous_response_id on the OAuth/store:false path (no server-side chain)", async () => {
    // OAuth forces store:false. previous_response_id requires a stored prior
    // turn, so shipping it would 400 / silently desync. The adapter must strip
    // it. This is the combination the original incident ran under
    // (ChatGPT-Codex OAuth, store:false), where stateful resend was never
    // possible regardless of the canonical pointer.
    const request = await captureOpenAIResponseRequest(
      {
        kind: "oauth",
        token: "AT",
        baseUrl: "https://chatgpt.com/backend-api/codex/",
        headers: { "ChatGPT-Account-ID": "acct-1" },
      },
      { previousResponseId: "resp_prev" },
    )

    const body = JSON.parse(String(request.body))
    expect(body.store).toBe(false)
    expect(body.previous_response_id).toBeUndefined()
  })

  it("drops previous_response_id on the default API-key path (store defaults false)", async () => {
    // Even on API-key auth, store defaults to false, so the same invariant
    // holds: no server-side chain => no pointer. Closing the stateful loop
    // would require deliberately setting vendor.openai.store=true AND a
    // delta-resend agent loop, both out of scope here.
    const request = await captureOpenAIResponseRequest(
      { kind: "api-key", key: "sk-test" },
      { previousResponseId: "resp_prev" },
    )

    const body = JSON.parse(String(request.body))
    expect(body.store).toBe(false)
    expect(body.previous_response_id).toBeUndefined()
  })

  it("keeps previous_response_id when store is explicitly true (vendor opt-in)", async () => {
    // The pointer is honored only when the server actually kept the prior
    // turn (store:true). In OpenAI's reference Codex client that is Azure-only
    // (codex-rs/core/src/client.rs:883: store = is_azure_responses_endpoint());
    // we additionally expose vendor.openai.store=true as an explicit opt-in.
    // store:true is the precondition — NOT auth.kind. API-key alone is still
    // store:false.
    const request = await captureOpenAIResponseRequest(
      { kind: "api-key", key: "sk-test" },
      { previousResponseId: "resp_prev", vendor: { openai: { store: true } } },
    )

    const body = JSON.parse(String(request.body))
    expect(body.store).toBe(true)
    expect(body.previous_response_id).toBe("resp_prev")
  })
})

describe("openaiProviderPlugin auth strategy", () => {
  it("exposes API-key auth and OAuth login strategies", () => {
    expect(openaiProviderPlugin.apiKeyAuth).toBe(openAIApiKeyAuth)
    expect(openaiProviderPlugin.oauthLogin).toBe(openAIOAuthLogin)
  })

  it("declares the OpenAI API-key credential codec", () => {
    expect(openAIApiKeyAuth.serviceId).toBe(OPENAI_API_KEY_AUTH.serviceId)
    expect(openAIApiKeyAuth.displayName).toBe("OpenAI API Key")

    const write = buildOpenAIApiKeyCredential("sk-test")
    expect(write).toEqual({
      serviceId: "openai-api-key",
      displayName: "OpenAI API Key",
      secrets: { tokenType: "api-key", apiKey: "sk-test" },
    })
    expect(readOpenAIApiKey(write.secrets)).toBe("sk-test")
    expect(readOpenAIApiKey({ tokenType: "api-key" })).toBeNull()
    expect(openAIApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(openAIApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("declares Codex-compatible OpenAI OAuth login settings", () => {
    const config = openAIOAuthLogin.config()
    expect(config.clientId).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(config.authorizeUrl).toBe("https://auth.openai.com/oauth/authorize")
    expect(config.tokenUrl).toBe("https://auth.openai.com/oauth/token")
    expect(config.tokenRequestEncoding).toBe("form")
    expect(config.tokenRequestIncludesState).toBe(false)
    expect(config.scopes).toContain("offline_access")
  })

  it("inspects OAuth credentials without exposing tokens", () => {
    const info = openAIOAuthLogin.inspectCredential?.({
      tokenType: "oauth",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 1_700_000_000_000,
      accountId: "acct-1",
      userId: "user-1",
      scopes: ["openid", "profile"],
    })

    expect(info).toEqual({
      usable: true,
      expiresAt: 1_700_000_000_000,
      hasRefreshToken: true,
      accountId: "acct-1",
      scopes: ["openid", "profile"],
    })
    expect(JSON.stringify(info)).not.toContain("AT")
    expect(JSON.stringify(info)).not.toContain("RT")
  })

  it("aborts device-code polling while waiting for authorization", async () => {
    const ac = new AbortController()
    let requests = 0
    const networkClient = {
      async request() {
        requests++
        return {
          ok: false,
          status: 403,
          headers: new Headers(),
          body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
          transport: { id: "test" },
          text: async () => "authorization pending",
          json: async () => ({}),
        }
      },
    }

    const promise = openAIOAuthLogin.deviceCode!.complete(
      {
        verificationUrl: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
        pollIntervalMs: 60_000,
        providerData: { deviceAuthId: "dev-1" },
      },
      { networkClient, signal: ac.signal },
    )
    await Promise.resolve()
    ac.abort()

    await expect(promise).rejects.toThrow("aborted")
    expect(requests).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateOpenAIRequest", () => {
  function setup() {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapOpenAI()
  }

  it("accepts a plain Responses request on gpt-5.6 with the raw none effort", () => {
    setup()
    const adapter = resolveProvider("openai")
    const model = resolveModel("gpt-5.6")
    const req: CanonicalRequest = {
      modelId: "gpt-5.6",
      messages: [userText("hi")],
      effort: "none",
    }
    expect(adapter.validate(req, model).ok).toBe(true)
  })

  it("rejects previousResponseId on the Chat surface (no server-side history)", () => {
    setup()
    const adapter = resolveProvider("openai")
    const model = resolveModel("gpt-5.5-chat")
    const req: CanonicalRequest = {
      modelId: "gpt-5.5-chat",
      messages: [userText("hi")],
      previousResponseId: "resp_123",
    }
    const res = adapter.validate(req, model)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.capability === "serverSideHistory")).toBe(true)
  })

  it("rejects an unsupported effort level", () => {
    setup()
    const adapter = resolveProvider("openai")
    const model = resolveModel("gpt-4o")
    const req: CanonicalRequest = { modelId: "gpt-4o", messages: [userText("hi")], effort: "high" }
    const res = adapter.validate(req, model)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.capability === "effort")).toBe(true)
  })
})
