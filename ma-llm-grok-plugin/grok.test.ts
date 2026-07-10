/**
 * Grok provider tests (offline) — dual surface, auth, quotas, vision.
 *
 * @module llm/providers/grok/grok.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { bootstrapGrok, grokAdapter, grokProviderPlugin } from "./adapter.ts"
import {
  buildGrokApiKeyCredential,
  GROK_API_KEY_AUTH,
  grokApiKeyAuth,
  readGrokApiKey,
} from "./auth.ts"
import {
  CAPS_GROK_45_CHAT,
  CAPS_GROK_45_RESPONSES,
  CAPS_GROK_COMPOSER_25_FAST,
} from "./capabilities.ts"
import { buildGrokHeaders } from "./headers.ts"
import { type CanonicalEvent, isEvent } from "./lib/canonical-events.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./lib/openai-chat.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerGrokModels } from "./models.ts"
import {
  GROK_OAUTH,
  GROK_OIDC_CLIENT_ID,
  buildGrokOAuthCredential,
  grokOAuthLogin,
  readGrokOAuthAuth,
} from "./oauth-login.ts"
import {
  clearGrokSessionCaches,
  fetchGrokSessionInfo,
  getGrokRateLimits,
  getGrokSessionUsage,
  parseGrokQuotaWindows,
  setGrokBillingQuota,
  setGrokRateLimits,
} from "./session-info.ts"
import { grokChatCompletionsCodec } from "./surface-codecs.ts"

function fakeNetworkClient(status: number, body: string) {
  return {
    async request() {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        headers: new Headers(),
        body: sseStream(body),
      }
    },
  } as unknown as NetworkClient
}

async function drainCatch(
  gen: AsyncIterable<unknown>,
): Promise<(Error & { streamErrorType?: string }) | null> {
  try {
    for await (const _ of gen) {
      /* drain */
    }
    return null
  } catch (err) {
    return err as Error & { streamErrorType?: string }
  }
}

let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapGrok({ models: reg.models, providers: reg.providers })
}
function resolveModel(id: string) {
  return reg.resolveModel(id)
}
function resolveProvider(id: string) {
  return reg.resolveProvider(id)
}

function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function openaiChatPong(): string {
  return readFileSync(join(import.meta.dir, "__fixtures__/chat-pong.sse"), "utf-8")
}

describe("llm-grok provider plugin (architecture-aligned)", () => {
  it("exposes API-key + OAuth (device-code) strategies", () => {
    expect(grokProviderPlugin.apiKeyAuth).toBe(grokApiKeyAuth)
    expect(grokProviderPlugin.oauthLogin).toBe(grokOAuthLogin)
    expect(grokProviderPlugin.oauthLogin?.deviceCode).toBeDefined()
    expect(grokProviderPlugin.id).toBe("grok")
    expect(grokProviderPlugin.shortCode).toBe("xai")
    expect(grokOAuthLogin.serviceId).toBe(GROK_OAUTH.serviceId)
    expect(grokOAuthLogin.config().clientId).toBe(GROK_OIDC_CLIENT_ID)
  })

  it("declares the Grok API-key credential codec", () => {
    expect(grokApiKeyAuth.serviceId).toBe(GROK_API_KEY_AUTH.serviceId)
    const write = buildGrokApiKeyCredential("xai-test-key")
    expect(write.secrets).toEqual({ tokenType: "api-key", apiKey: "xai-test-key" })
    expect(readGrokApiKey(write.secrets)).toBe("xai-test-key")
    expect(grokApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
  })

  it("encodes/decodes OAuth secrets with cli-chat-proxy routing", () => {
    const built = buildGrokOAuthCredential({
      access_token: "eyJ.payload.sig",
      refresh_token: "rt-1",
      expires_in: 3600,
      scope: "openid profile",
    })
    expect(built.credential.serviceId).toBe("grok-oauth")
    const auth = readGrokOAuthAuth(built.credential.secrets)
    expect(auth?.kind).toBe("oauth")
    if (auth?.kind === "oauth") {
      expect(auth.token).toBe("eyJ.payload.sig")
      expect(auth.baseUrl).toContain("cli-chat-proxy.grok.com")
      expect(auth.headers?.["X-XAI-Token-Auth"]).toBe("xai-grok-cli")
    }
  })

  it("registers dual surfaces: Responses preferred for frontier, Chat available", () => {
    setup()
    const flagship = resolveModel("grok-4.5")
    expect(flagship.providerId).toBe("grok")
    expect(flagship.surfaceId).toBe("openai-responses")
    expect(flagship.vendorIds?.firstParty).toBe("grok-4.5")
    expect(flagship.capabilities.contextWindow).toBe(500_000)
    expect(flagship.capabilities.modalities.image).toBe(true)
    expect(flagship.capabilities.thinking.visible).toBe(true)
    expect(flagship.capabilities).toEqual(CAPS_GROK_45_RESPONSES)

    const chat = resolveModel("grok-4.5-chat")
    expect(chat.surfaceId).toBe("openai-chat-completions")
    expect(chat.vendorIds?.firstParty).toBe("grok-4.5")
    expect(chat.capabilities.thinking.visible).toBe(false)
    expect(chat.capabilities.contextWindow).toBe(CAPS_GROK_45_CHAT.contextWindow)

    const adapter = resolveProvider("grok")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("openai-responses")
  })

  it("registers composer on chat with vision + speed", () => {
    setup()
    const m = resolveModel("grok-composer-2.5-fast")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.capabilities.speedFast).toBe(true)
    expect(m.capabilities.modalities.image).toBe(true)
    expect(m.capabilities.contextWindow).toBe(CAPS_GROK_COMPOSER_25_FAST.contextWindow)
  })

  it("enables image modality on every catalog model", () => {
    setup()
    for (const id of [
      "grok-4.5",
      "grok-4.5-chat",
      "grok-build",
      "grok-build-chat",
      "grok-composer-2.5-fast",
    ]) {
      expect(resolveModel(id).capabilities.modalities.image).toBe(true)
    }
  })

  it("validates text + image requests on vision models", () => {
    setup()
    const model = resolveModel("grok-4.5-chat")
    expect(
      grokAdapter.validate(
        { modelId: model.id, messages: [userText("hello")] },
        model,
      ).ok,
    ).toBe(true)

    const withImage: CanonicalRequest = {
      modelId: model.id,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    }
    expect(grokAdapter.validate(withImage, model).ok).toBe(true)
  })

  it("streams Chat Completions on the -chat surface", async () => {
    setup()
    clearGrokSessionCaches()
    const model = resolveModel("grok-4.5-chat")
    const raw = openaiChatPong()
    const client = {
      async request() {
        return {
          ok: true,
          status: 200,
          text: async () => raw,
          headers: new Headers({
            "x-ratelimit-limit-requests": "60",
            "x-ratelimit-remaining-requests": "59",
            "x-ratelimit-reset-requests": "1s",
            "x-ratelimit-limit-tokens": "100000",
            "x-ratelimit-remaining-tokens": "99900",
            "x-ratelimit-reset-tokens": "60s",
          }),
          body: sseStream(raw),
        }
      },
    } as unknown as NetworkClient

    const ctx: RunContext = {
      auth: { kind: "api-key", key: "xai-test" },
      networkClient: client,
    }
    const events: CanonicalEvent[] = []
    for await (const ev of grokAdapter.run(
      { modelId: model.id, messages: [userText("ping")] },
      model,
      ctx,
    )) {
      events.push(ev)
    }

    const text = events
      .filter((e) => isEvent(e, "text_delta"))
      .map((e) => (e as { type: "text_delta"; text: string }).text)
      .join("")
    expect(text).toContain("pong")
    expect(getGrokSessionUsage()?.inputTokens).toBeGreaterThan(0)
  })

  it("tags HTTP errors with streamErrorType for host retries", async () => {
    setup()
    const model = resolveModel("grok-4.5-chat")
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "xai-test" },
      networkClient: fakeNetworkClient(
        429,
        JSON.stringify({ error: { type: "rate_limit_error" } }),
      ),
    }
    const err = await drainCatch(
      grokAdapter.run({ modelId: model.id, messages: [userText("hi")] }, model, ctx),
    )
    expect(err?.message).toContain("429")
    expect(err?.streamErrorType).toBeTruthy()
  })

  it("buildGrokHeaders sets Bearer and session tags", () => {
    const apiHeaders = buildGrokHeaders({ auth: { kind: "api-key", key: "k" } })
    expect(apiHeaders.authorization).toBe("Bearer k")
    expect(apiHeaders["user-agent"]).toContain("minimal-agent-grok")

    const oauthHeaders = buildGrokHeaders({
      auth: { kind: "oauth", token: "tok" },
      modelId: "grok-4.5",
    })
    expect(oauthHeaders.authorization).toBe("Bearer tok")
    expect(oauthHeaders["X-XAI-Token-Auth"]).toBe("xai-grok-cli")
    expect(oauthHeaders["x-grok-model-override"]).toBe("grok-4.5")
    expect(oauthHeaders["x-grok-client-version"]).toBe("0.2.93")
    expect(oauthHeaders["x-grok-client-identifier"]).toBe("grok-shell")
  })

  it("parses rpm/tpm + monthly billing quota windows", () => {
    clearGrokSessionCaches()
    setGrokRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "30",
        "x-ratelimit-reset-requests": "30s",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "250",
        "x-ratelimit-reset-tokens": "60s",
      }),
    )
    setGrokBillingQuota({ used: 100, limit: 4000, periodEndMs: Date.now() + 86400000 })
    const windows = parseGrokQuotaWindows(getGrokRateLimits()!.rateLimits)
    expect(windows.map((w) => w.id)).toEqual(expect.arrayContaining(["rpm", "tpm", "month"]))
    expect(windows.find((w) => w.id === "rpm")?.utilization).toBeCloseTo(0.5, 5)
    expect(windows.find((w) => w.id === "month")?.utilization).toBeCloseTo(0.025, 5)
  })

  it("fetchSessionInfo returns context + label + quotas", async () => {
    setup()
    clearGrokSessionCaches()
    setGrokRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "10",
        "x-ratelimit-remaining-requests": "5",
        "x-ratelimit-reset-requests": "1s",
      }),
    )
    const info = await fetchGrokSessionInfo({ modelId: "grok-4.5" })
    expect(info?.contextWindow).toBe(500_000)
    expect(info?.modelLabel).toBe("xai-4.5")
    expect((info?.quota?.windows?.length ?? 0) > 0).toBe(true)
  })

  it("recommends subagent models by tags", () => {
    setup()
    const recs = grokAdapter.recommendSubagentModels?.() ?? []
    expect(recs.find((r) => r.role === "deep")?.modelId).toBe("grok-4.5")
    expect(recs.find((r) => r.role === "scout")?.modelId).toBe("grok-composer-2.5-fast")
    expect(recs.find((r) => r.role === "balanced")?.modelId).toBe("grok-build")
  })

  it("exposes a chat surface codec for generic-endpoint reuse", () => {
    expect(grokChatCompletionsCodec.surfaceId).toBe("openai-chat-completions")
    expect(grokChatCompletionsCodec.defaultPath).toBe("/v1/chat/completions")
    expect(grokChatCompletionsCodec.defaultCapabilities.modalities.image).toBe(true)
  })

  it("registerGrokModels returns dual-surface catalog size", () => {
    setup()
    const ids = registerGrokModels(reg.models)
    // 2× frontier + 2× build + 1 composer = 5
    expect(ids.length).toBe(5)
    registerGrokModels(reg.models) // idempotent
  })

  it("translates fixture SSE independently", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateOpenAIChatStream(
      parseSse<OpenAIChatChunk>(sseStream(openaiChatPong())),
    )) {
      events.push(ev)
    }
    expect(events.some((e) => isEvent(e, "text_delta"))).toBe(true)
  })
})
