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
import { CAPS_GROK_45_CHAT, CAPS_GROK_45_RESPONSES } from "./capabilities.ts"
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
  buildGrokOAuthCredential,
  GROK_OAUTH,
  GROK_OIDC_CLIENT_ID,
  grokOAuthLogin,
  readGrokOAuthAuth,
} from "./oauth-login.ts"
import {
  _resetGrokPrimeInFlight,
  clearGrokSessionCaches,
  fetchGrokSessionInfo,
  getGrokBillingQuota,
  getGrokRateLimits,
  getGrokSessionUsage,
  parseGrokQuotaWindows,
  primeGrokSessionInfo,
  readGrokOAuthTokenFromAuthStore,
  refreshGrokBillingQuota,
  setGrokBillingQuota,
  setGrokRateLimits,
} from "./session-info.ts"
import { grokChatCompletionsCodec } from "./surface-codecs.ts"
import { CLI_BILLING_URL, CLI_MODELS_URL, MODELS_URL } from "./wire-constants.ts"

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
    // live cli-models reasoning_efforts (api.x.ai omits efforts)
    expect(flagship.capabilities.effort.levels).toEqual(["low", "medium", "high"])
    expect(flagship.capabilities.effort.default).toBe("high")
    expect(flagship.capabilities.acceptsStopSequences).toBe(false)
    expect(flagship.capabilities.caching.promptCacheAccounting).toBe("subset")
    // live micros 20000/60000/3000 → USD/1M
    expect(flagship.pricing.inputUSD).toBe(2)
    expect(flagship.pricing.outputUSD).toBe(6)
    expect(flagship.pricing.cacheReadUSD).toBe(0.3)
    expect(flagship.pricing.longContext?.thresholdTokens).toBe(200_000)
    expect(flagship.pricing.longContext?.inputUSD).toBe(4)
    expect(flagship.pricing.longContext?.outputUSD).toBe(12)
    expect(flagship.pricing.longContext?.cacheReadUSD).toBe(0.6)
    expect(flagship.aliases).toEqual(
      expect.arrayContaining(["grok-4.5-latest", "grok-build-latest"]),
    )
    expect(flagship.capabilities).toEqual(CAPS_GROK_45_RESPONSES)

    const chat = resolveModel("grok-4.5-chat")
    expect(chat.surfaceId).toBe("openai-chat-completions")
    expect(chat.vendorIds?.firstParty).toBe("grok-4.5")
    expect(chat.capabilities.thinking.visible).toBe(false)
    expect(chat.capabilities.contextWindow).toBe(CAPS_GROK_45_CHAT.contextWindow)

    const build = resolveModel("grok-build")
    expect(build.vendorIds?.firstParty).toBe("grok-build-0.1")
    expect(build.capabilities.contextWindow).toBe(256_000)
    // live micros 10000/20000/2000
    expect(build.pricing.inputUSD).toBe(1)
    expect(build.pricing.outputUSD).toBe(2)
    expect(build.pricing.cacheReadUSD).toBe(0.2)
    expect(build.aliases).toEqual(
      expect.arrayContaining(["grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"]),
    )

    const adapter = resolveProvider("grok")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("openai-responses")
  })

  it("registers grok-4.3 as the fast scout tier (1M ctx)", () => {
    setup()
    const m = resolveModel("grok-4.3")
    expect(m.surfaceId).toBe("openai-responses")
    expect(m.capabilities.speedFast).toBe(true)
    expect(m.capabilities.contextWindow).toBe(1_000_000)
    expect(m.capabilities.modalities.image).toBe(true)
    // live micros 12500/25000/2000
    expect(m.pricing.inputUSD).toBe(1.25)
    expect(m.pricing.outputUSD).toBe(2.5)
    expect(m.pricing.cacheReadUSD).toBe(0.2)
    expect(m.pricing.longContext?.inputUSD).toBe(2.5)
    expect(m.pricing.longContext?.outputUSD).toBe(5)
    expect(m.aliases).toEqual(expect.arrayContaining(["grok-4.3-latest", "grok-latest"]))
  })

  it("registers grok-4.20 family with live wire ids, context, and stable aliases", () => {
    setup()
    const reasoning = resolveModel("grok-4.20-reasoning")
    expect(reasoning.vendorIds?.firstParty).toBe("grok-4.20-0309-reasoning")
    expect(reasoning.capabilities.contextWindow).toBe(1_000_000)
    expect(reasoning.capabilities.modalities.image).toBe(true)
    expect(reasoning.pricing.inputUSD).toBe(1.25)
    expect(reasoning.aliases).toEqual(
      expect.arrayContaining(["grok-4.20", "grok-4.20-reasoning-latest", "grok-4.20-0309"]),
    )

    const nonReasoning = resolveModel("grok-4.20-non-reasoning")
    expect(nonReasoning.vendorIds?.firstParty).toBe("grok-4.20-0309-non-reasoning")
    expect(nonReasoning.capabilities.contextWindow).toBe(1_000_000)
    expect(nonReasoning.capabilities.effort.levels).toEqual([])
    expect(nonReasoning.aliases).toEqual(expect.arrayContaining(["grok-4.20-non-reasoning-latest"]))

    const multi = resolveModel("grok-4.20-multi-agent")
    expect(multi.vendorIds?.firstParty).toBe("grok-4.20-multi-agent-0309")
    expect(multi.capabilities.contextWindow).toBe(1_000_000)
    expect(multi.capabilities.effort.levels).toEqual(["low", "medium", "high", "xhigh"])
    expect(multi.aliases).toEqual(expect.arrayContaining(["grok-4.20-multi-agent-latest"]))
  })

  it("enables image modality on every catalog text model", () => {
    setup()
    for (const id of [
      "grok-4.5",
      "grok-4.5-chat",
      "grok-build",
      "grok-build-chat",
      "grok-4.3",
      "grok-4.3-chat",
      "grok-4.20-reasoning",
      "grok-4.20-non-reasoning",
      "grok-4.20-multi-agent",
    ]) {
      expect(resolveModel(id).capabilities.modalities.image).toBe(true)
    }
  })

  it("validates text + image requests on vision models", () => {
    setup()
    const model = resolveModel("grok-4.5-chat")
    expect(
      grokAdapter.validate({ modelId: model.id, messages: [userText("hello")] }, model).ok,
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
              source: { kind: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
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
      sessionId: "test-session",
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
      sessionId: "test-session",
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

  it("refreshGrokBillingQuota parses /billing and caches month window", async () => {
    clearGrokSessionCaches()
    const body = JSON.stringify({
      config: {
        monthlyLimit: { val: 15_000 },
        used: { val: 13 },
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      },
    })
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const networkClient = {
      async request(input: { url: string; headers?: Record<string, string> }) {
        calls.push({ url: input.url, headers: input.headers })
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => body,
          json: async () => JSON.parse(body),
        }
      },
    } as unknown as NetworkClient

    await refreshGrokBillingQuota(networkClient, "oauth-token-xyz")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CLI_BILLING_URL)
    expect(calls[0]!.headers?.authorization).toBe("Bearer oauth-token-xyz")
    expect(calls[0]!.headers?.["x-xai-token-auth"]).toBe("xai-grok-cli")

    const cached = getGrokBillingQuota()
    expect(cached?.used).toBe(13)
    expect(cached?.limit).toBe(15_000)
    expect(cached?.periodEndMs).toBe(Date.parse("2026-08-01T00:00:00+00:00"))

    const windows = parseGrokQuotaWindows(new Map())
    expect(windows.map((w) => w.id)).toEqual(["month"])
    expect(windows[0]!.utilization).toBeCloseTo(13 / 15_000, 6)
  })

  it("caches Free monthlyLimit=0 without emitting a month window", async () => {
    clearGrokSessionCaches()
    const body = JSON.stringify({
      config: {
        monthlyLimit: { val: 0 },
        used: { val: 8524 },
        onDemandCap: { val: 0 },
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      },
    })
    const networkClient = {
      async request() {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => body,
          json: async () => JSON.parse(body),
        }
      },
    } as unknown as NetworkClient

    await refreshGrokBillingQuota(networkClient, "oauth-free")
    expect(getGrokBillingQuota()?.limit).toBe(0)
    expect(getGrokBillingQuota()?.used).toBe(8524)
    expect(parseGrokQuotaWindows(new Map()).map((w) => w.id)).toEqual([])
  })

  it("emits ondemand window when onDemandCap > 0", async () => {
    clearGrokSessionCaches()
    const body = JSON.stringify({
      config: {
        monthlyLimit: { val: 4000 },
        used: { val: 100 },
        onDemandCap: { val: 2000 },
        onDemandUsed: { val: 500 },
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      },
    })
    const networkClient = {
      async request() {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => body,
          json: async () => JSON.parse(body),
        }
      },
    } as unknown as NetworkClient

    await refreshGrokBillingQuota(networkClient, "oauth-od")
    const ids = parseGrokQuotaWindows(new Map()).map((w) => w.id)
    expect(ids).toEqual(["month", "ondemand"])
    expect(
      parseGrokQuotaWindows(new Map()).find((w) => w.id === "ondemand")?.utilization,
    ).toBeCloseTo(0.25, 5)
  })

  it("readGrokOAuthTokenFromAuthStore selects credentialName among multiple entries", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const prev = process.env["MINIMAL_AGENT_HOME"]
    const dir = mkdtempSync(join(tmpdir(), "ma-grok-auth-multi-"))
    process.env["MINIMAL_AGENT_HOME"] = dir
    writeFileSync(
      join(dir, "auth.jsonc"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "grok-oauth",
            name: "Grok / xAI (OAuth)",
            secrets: { accessToken: "token-default" },
          },
          {
            id: "grok-oauth",
            name: "grok-oauth-3",
            secrets: { accessToken: "token-three" },
          },
        ],
      }),
    )
    try {
      expect(readGrokOAuthTokenFromAuthStore()).toBe("token-default")
      expect(readGrokOAuthTokenFromAuthStore("grok-oauth-3")).toBe("token-three")
      expect(readGrokOAuthTokenFromAuthStore("missing")).toBeNull()
    } finally {
      if (prev === undefined) delete process.env["MINIMAL_AGENT_HOME"]
      else process.env["MINIMAL_AGENT_HOME"] = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("prime with authKind=oauth ignores env API key and uses named credential", async () => {
    clearGrokSessionCaches()
    _resetGrokPrimeInFlight()
    const prev = {
      a: process.env["MINIMAL_AGENT_GROK_API_KEY"],
      b: process.env["XAI_API_KEY"],
      c: process.env["GROK_API_KEY"],
      home: process.env["MINIMAL_AGENT_HOME"],
    }
    process.env["XAI_API_KEY"] = "should-not-be-used"
    delete process.env["MINIMAL_AGENT_GROK_API_KEY"]
    delete process.env["GROK_API_KEY"]

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "ma-grok-auth-named-"))
    process.env["MINIMAL_AGENT_HOME"] = dir
    writeFileSync(
      join(dir, "auth.jsonc"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "grok-oauth",
            name: "Grok / xAI (OAuth)",
            secrets: { accessToken: "token-default" },
          },
          {
            id: "grok-oauth",
            name: "grok-oauth-3",
            secrets: { accessToken: "token-three" },
          },
        ],
      }),
    )

    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const networkClient = {
      async request(input: { url: string; headers?: Record<string, string> }) {
        calls.push({ url: input.url, headers: input.headers })
        if (input.url === CLI_BILLING_URL) {
          const body = JSON.stringify({
            config: { monthlyLimit: { val: 100 }, used: { val: 1 } },
          })
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: new ReadableStream(),
            transport: { id: "test" },
            text: async () => body,
            json: async () => JSON.parse(body),
          }
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "x-ratelimit-limit-tokens": "1000",
            "x-ratelimit-remaining-tokens": "900",
            "x-ratelimit-reset-tokens": "60s",
          }),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => "{}",
          json: async () => ({}),
        }
      },
    } as unknown as NetworkClient

    try {
      await primeGrokSessionInfo({
        modelId: "grok-4.5",
        networkClient,
        authKind: "oauth",
        credentialName: "grok-oauth-3",
      })
      expect(calls.some((c) => c.url === MODELS_URL)).toBe(false)
      expect(calls.some((c) => c.url === CLI_MODELS_URL)).toBe(true)
      expect(calls.find((c) => c.url === CLI_BILLING_URL)?.headers?.authorization).toBe(
        "Bearer token-three",
      )
      expect(getGrokBillingQuota()?.limit).toBe(100)
    } finally {
      if (prev.a === undefined) delete process.env["MINIMAL_AGENT_GROK_API_KEY"]
      else process.env["MINIMAL_AGENT_GROK_API_KEY"] = prev.a
      if (prev.b === undefined) delete process.env["XAI_API_KEY"]
      else process.env["XAI_API_KEY"] = prev.b
      if (prev.c === undefined) delete process.env["GROK_API_KEY"]
      else process.env["GROK_API_KEY"] = prev.c
      if (prev.home === undefined) delete process.env["MINIMAL_AGENT_HOME"]
      else process.env["MINIMAL_AGENT_HOME"] = prev.home
      rmSync(dir, { recursive: true, force: true })
      _resetGrokPrimeInFlight()
      clearGrokSessionCaches()
    }
  })

  it("primeGrokSessionInfo with API key probes models URL only", async () => {
    clearGrokSessionCaches()
    _resetGrokPrimeInFlight()
    const prev = {
      a: process.env["MINIMAL_AGENT_GROK_API_KEY"],
      b: process.env["XAI_API_KEY"],
      c: process.env["GROK_API_KEY"],
    }
    process.env["MINIMAL_AGENT_GROK_API_KEY"] = "xai-test-key"
    delete process.env["XAI_API_KEY"]
    delete process.env["GROK_API_KEY"]

    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const networkClient = {
      async request(input: { url: string; headers?: Record<string, string> }) {
        calls.push({ url: input.url, headers: input.headers })
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "x-ratelimit-limit-requests": "60",
            "x-ratelimit-remaining-requests": "59",
            "x-ratelimit-reset-requests": "30s",
          }),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => "{}",
          json: async () => ({}),
        }
      },
    } as unknown as NetworkClient

    try {
      await primeGrokSessionInfo({ modelId: "grok-4.5", networkClient })
      expect(calls.some((c) => c.url === MODELS_URL)).toBe(true)
      expect(calls.some((c) => c.url === CLI_BILLING_URL)).toBe(false)
      expect(getGrokRateLimits()?.rateLimits.get("x-ratelimit-limit-requests")).toBe("60")
      expect(getGrokBillingQuota()).toBeNull()
    } finally {
      if (prev.a === undefined) delete process.env["MINIMAL_AGENT_GROK_API_KEY"]
      else process.env["MINIMAL_AGENT_GROK_API_KEY"] = prev.a
      if (prev.b === undefined) delete process.env["XAI_API_KEY"]
      else process.env["XAI_API_KEY"] = prev.b
      if (prev.c === undefined) delete process.env["GROK_API_KEY"]
      else process.env["GROK_API_KEY"] = prev.c
      _resetGrokPrimeInFlight()
      clearGrokSessionCaches()
    }
  })

  it("primeGrokSessionInfo with OAuth hits billing + cli models", async () => {
    clearGrokSessionCaches()
    _resetGrokPrimeInFlight()
    const prev = {
      a: process.env["MINIMAL_AGENT_GROK_API_KEY"],
      b: process.env["XAI_API_KEY"],
      c: process.env["GROK_API_KEY"],
      home: process.env["MINIMAL_AGENT_HOME"],
    }
    delete process.env["MINIMAL_AGENT_GROK_API_KEY"]
    delete process.env["XAI_API_KEY"]
    delete process.env["GROK_API_KEY"]

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "ma-grok-auth-"))
    process.env["MINIMAL_AGENT_HOME"] = dir
    writeFileSync(
      join(dir, "auth.jsonc"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "grok-oauth",
            name: "Grok",
            secrets: { tokenType: "oauth", accessToken: "oauth-session-token" },
          },
        ],
      }),
    )

    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const networkClient = {
      async request(input: { url: string; headers?: Record<string, string> }) {
        calls.push({ url: input.url, headers: input.headers })
        if (input.url === CLI_BILLING_URL) {
          const body = JSON.stringify({
            config: {
              monthlyLimit: { val: 4000 },
              used: { val: 154 },
              billingPeriodEnd: "2026-08-01T00:00:00+00:00",
            },
          })
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: new ReadableStream(),
            transport: { id: "test" },
            text: async () => body,
            json: async () => JSON.parse(body),
          }
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "x-ratelimit-limit-tokens": "1000",
            "x-ratelimit-remaining-tokens": "900",
            "x-ratelimit-reset-tokens": "60s",
          }),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => "{}",
          json: async () => ({}),
        }
      },
    } as unknown as NetworkClient

    try {
      await primeGrokSessionInfo({ modelId: "grok-4.5", networkClient })
      expect(calls.some((c) => c.url === CLI_MODELS_URL)).toBe(true)
      expect(calls.some((c) => c.url === CLI_BILLING_URL)).toBe(true)
      expect(calls.find((c) => c.url === CLI_BILLING_URL)?.headers?.authorization).toBe(
        "Bearer oauth-session-token",
      )
      expect(getGrokBillingQuota()?.used).toBe(154)
      expect(getGrokBillingQuota()?.limit).toBe(4000)

      const info = await fetchGrokSessionInfo({ modelId: "grok-4.5" })
      const ids = info?.quota?.windows?.map((w) => w.id) ?? []
      expect(ids).toEqual(expect.arrayContaining(["tpm", "month"]))
    } finally {
      if (prev.a === undefined) delete process.env["MINIMAL_AGENT_GROK_API_KEY"]
      else process.env["MINIMAL_AGENT_GROK_API_KEY"] = prev.a
      if (prev.b === undefined) delete process.env["XAI_API_KEY"]
      else process.env["XAI_API_KEY"] = prev.b
      if (prev.c === undefined) delete process.env["GROK_API_KEY"]
      else process.env["GROK_API_KEY"] = prev.c
      if (prev.home === undefined) delete process.env["MINIMAL_AGENT_HOME"]
      else process.env["MINIMAL_AGENT_HOME"] = prev.home
      rmSync(dir, { recursive: true, force: true })
      _resetGrokPrimeInFlight()
      clearGrokSessionCaches()
    }
  })

  it("recommends subagent models by tags", () => {
    setup()
    const recs = grokAdapter.recommendSubagentModels?.() ?? []
    expect(recs.find((r) => r.role === "deep")?.modelId).toBe("grok-4.5")
    expect(recs.find((r) => r.role === "scout")?.modelId).toBe("grok-4.3")
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
    // 2×4.5 + 2×build + 2×4.3 + 3×4.20 = 9
    expect(ids.length).toBe(9)
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
