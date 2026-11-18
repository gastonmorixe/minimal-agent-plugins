import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"
import type { RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"

import {
  bootstrapOpencodeZen,
  OPENCODE_ZEN_CHAT_URL,
  OPENCODE_ZEN_MESSAGES_URL,
  OPENCODE_ZEN_RESPONSES_URL,
  opencodeProviderPlugin,
  opencodeZenAdapter,
  taggedHttpError,
  ZEN_ERROR_CODES,
} from "./adapter.ts"
import {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  readOpencodeApiKey,
} from "./auth.ts"
import { buildAnthropicRequestBody } from "./lib/anthropic-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { LIVE_MODEL_IDS } from "./models.ts"
import { opencodeConsoleOAuthLogin } from "./oauth-login.ts"
import { OPENCODE_VERSION_ENV, opencodeProjectId, opencodeSessionId } from "./opencode-identity.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"

const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const LOGIN_HINT = "run: ma provider opencode-zen login"

function setup() {
  const reg = makeTestRegistry()
  bootstrapOpencodeZen({ models: reg.models, providers: reg.providers })
  return reg
}

const readTool = { name: "Read", description: "read a file", inputSchema: { type: "object" } }

describe("llm-opencode-zen", () => {
  it("exposes provider metadata and all three auth strategies", () => {
    expect(opencodeProviderPlugin.id).toBe("opencode-zen")
    expect(opencodeProviderPlugin.displayName).toBe("OpenCode Zen")
    expect(opencodeProviderPlugin.shortCode).toBe("oz")
    expect(opencodeProviderPlugin.apiKeyAuth).toBe(opencodeApiKeyAuth)
    expect(opencodeProviderPlugin.oauthLogin).toBe(opencodeConsoleOAuthLogin)
    expect(opencodeProviderPlugin.anonymousAuth?.()).toEqual({ kind: "api-key", key: "public" })
    expect(OPENCODE_API_KEY_AUTH.serviceId).toBe("opencode-api-key")
    expect(readOpencodeApiKey(buildOpencodeApiKeyCredential("zen-test-key").secrets)).toBe(
      "zen-test-key",
    )
  })

  it("registers every live Zen model with the documented surface", () => {
    const reg = setup()
    expect(LIVE_MODEL_IDS).toHaveLength(87)
    for (const id of LIVE_MODEL_IDS) {
      const model = reg.resolveModel(id)
      expect(model.providerId).toBe("opencode-zen")
      if (id.startsWith("claude-") || id.startsWith("qwen"))
        expect(model.surfaceId).toBe("anthropic-messages")
      else if (id.startsWith("gpt-") || id.startsWith("grok-") || id.startsWith("muse-"))
        expect(model.surfaceId).toBe("openai-responses")
      else expect(model.surfaceId).toBe("openai-chat-completions")
      expect(model.pricing).toBeDefined()
      expect(model.capabilities.contextWindow).toBeGreaterThan(0)
    }
  })

  it("registers the 2026-11-18 live additions with models.dev pricing", () => {
    const reg = setup()
    // GPT-6.2 Astra (frontier) + GPT-6.2 Sol (efficient), both Responses.
    const astra = reg.resolveModel("gpt-6.2-astra")
    expect(astra.surfaceId).toBe("openai-responses")
    expect(astra.pricing?.inputUSD).toBe(8)
    expect(astra.pricing?.outputUSD).toBe(40)
    expect(astra.pricing?.cacheWriteUSD).toBe(10)
    const sol = reg.resolveModel("gpt-6.2-sol")
    expect(sol.surfaceId).toBe("openai-responses")
    expect(sol.pricing?.inputUSD).toBe(2)
    expect(sol.pricing?.outputUSD).toBe(10)
    expect(sol.pricing?.cacheWriteUSD).toBe(2.5)
    // Hy4 Flash Free rides the free/chat bucket.
    const hy4f = reg.resolveModel("hy4-flash-free")
    expect(hy4f.surfaceId).toBe("openai-chat-completions")
    expect(hy4f.tags).toContain("free")
    expect(hy4f.pricing?.inputUSD).toBe(0)
    // Retired free SKUs left the live list.
    for (const retired of ["glm-5.3-flash-free", "minimax-m3.1-flash-free"]) {
      expect(() => reg.resolveModel(retired)).toThrow()
    }
  })

  it("registers the 2026-11-15 live additions with models.dev pricing", () => {
    const reg = setup()
    const fable = reg.resolveModel("claude-fable-5-2")
    expect(fable.surfaceId).toBe("anthropic-messages")
    expect(fable.pricing?.inputUSD).toBe(8)
    expect(fable.pricing?.outputUSD).toBe(40)
    expect(fable.pricing?.cacheWriteUSD).toBe(10)
    expect(reg.resolveModel("gemini-4-carbon").pricing?.inputUSD).toBe(2)
    expect(reg.resolveModel("gemini-4-hydrogen").pricing?.inputUSD).toBe(1.5)
    const ember = reg.resolveModel("muse-ember-1.0")
    expect(ember.surfaceId).toBe("openai-responses")
    expect(ember.pricing?.inputUSD).toBe(0.1)
    expect(ember.pricing?.cacheReadUSD).toBe(0.004)
    for (const id of ["iceman-free", "inkling-2-small-free", "longcat-2.5-free"]) {
      const m = reg.resolveModel(id)
      expect(m.surfaceId).toBe("openai-chat-completions")
      expect(m.tags).toContain("free")
      expect(m.pricing?.inputUSD).toBe(0)
    }
  })

  it("declares only implemented surfaces and the inference URLs", () => {
    expect(opencodeZenAdapter.surfaces).toEqual([
      "openai-chat-completions",
      "anthropic-messages",
      "openai-responses",
    ])
    const reg = setup()
    const model = reg.resolveModel("beam-free")
    const request: CanonicalRequest = { modelId: model.id, messages: [userText("hello")] }
    expect(reg.resolveProvider("opencode-zen").validate(request, model).ok).toBe(true)
    expect(OPENCODE_ZEN_CHAT_URL).toBe("https://opencode.ai/inference/openai/v1/chat/completions")
    expect(OPENCODE_ZEN_RESPONSES_URL).toBe("https://opencode.ai/inference/openai/v1/responses")
    expect(OPENCODE_ZEN_MESSAGES_URL).toBe("https://opencode.ai/inference/anthropic/v1/messages")
  })

  describe("wire request", () => {
    type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

    function sseBody(lines: string[]): ReadableStream<Uint8Array> {
      const enc = new TextEncoder()
      return new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`))
          c.close()
        },
      })
    }

    async function capture(
      modelId: string,
      opts: {
        auth?: RunContext["auth"]
        req?: Partial<CanonicalRequest>
        sessionId?: string
      } = {},
    ): Promise<Captured> {
      const reg = setup()
      const model = reg.resolveModel(modelId)
      let seen: Captured | undefined
      const networkClient = {
        async request(input: { url: string; headers: Record<string, string>; body: string }) {
          seen = { url: input.url, headers: input.headers, body: JSON.parse(input.body) }
          return {
            ok: false,
            status: 418,
            async text() {
              return "stop"
            },
          }
        },
      }
      const run = opencodeZenAdapter.run(
        { modelId: model.id, messages: [userText("hi")], ...opts.req },
        model,
        {
          auth: opts.auth ?? { kind: "api-key", key: "zen-key" },
          sessionId: opts.sessionId ?? "sess-123",
          networkClient,
        },
      )
      await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow("418")
      if (!seen) throw new Error("no request captured")
      return seen
    }

    for (const [modelId, url] of [
      ["beam-free", OPENCODE_ZEN_CHAT_URL],
      ["claude-sonnet-5", OPENCODE_ZEN_MESSAGES_URL],
      ["gpt-5.5", OPENCODE_ZEN_RESPONSES_URL],
    ] as const) {
      it(`sends identity headers, stream:true, and the right URL (${modelId})`, async () => {
        const prev = process.env[OPENCODE_VERSION_ENV]
        process.env[OPENCODE_VERSION_ENV] = "2.0.32"
        try {
          const { headers, body, url: sent } = await capture(modelId)
          const ses = opencodeSessionId("sess-123")
          expect(sent).toBe(url)
          expect(ses).toMatch(SES_RE)
          expect(headers["user-agent"]).toBe("opencode/latest/2.0.32/minimal-agent")
          expect(headers["x-opencode-client"]).toBe("minimal-agent")
          expect(headers["x-opencode-session-id"]).toBe(ses)
          expect(headers["x-opencode-session"]).toBe(ses)
          expect(headers["x-session-affinity"]).toBe(ses)
          expect(headers["X-Session-Id"]).toBe(ses)
          expect(headers["x-opencode-project"]).toBe(opencodeProjectId())
          expect(body.stream).toBe(true)
        } finally {
          if (prev === undefined) delete process.env[OPENCODE_VERSION_ENV]
          else process.env[OPENCODE_VERSION_ENV] = prev
        }
      })
    }

    it("drops previous_response_id on Responses when store is not true", async () => {
      const { body } = await capture("gpt-5.5", {
        req: { previousResponseId: "resp_old" } as Partial<CanonicalRequest>,
      })
      expect(body.previous_response_id).toBeUndefined()
    })

    it("ad-hoc unknown paid ids are refused when anonymous", async () => {
      const reg = setup()
      opencodeProviderPlugin.registerAdHocModel?.("some-new-paid-model")
      const model = reg.resolveModel("some-new-paid-model")
      const run = opencodeZenAdapter.run({ modelId: model.id, messages: [userText("hi")] }, model, {
        auth: { kind: "api-key", key: "public" },
        sessionId: "s",
        networkClient: {
          request: async () => {
            throw new Error("must not send")
          },
        },
      })
      const err = await run[Symbol.asyncIterator]()
        .next()
        .catch((e: unknown) => e)
      expect((err as ProviderError).code).toBe(ZEN_ERROR_CODES.loginRequired)
    })

    it("keeps the ses_ id stable across requests of one session", async () => {
      const a = await capture("beam-free", { sessionId: "stable-1" })
      const b = await capture("gpt-5.5", { sessionId: "stable-1" })
      const c = await capture("beam-free", { sessionId: "stable-2" })
      expect(a.headers["x-opencode-session"]).toBe(b.headers["x-opencode-session"] as string)
      expect(c.headers["x-opencode-session"]).not.toBe(a.headers["x-opencode-session"] as string)
    })

    it("forces stream:true even when the request asks for no stream", async () => {
      const { body } = await capture("beam-free", { req: { stream: false } })
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
    })

    it("sends prompt_cache_key = ses_ id without prefix on chat and responses", async () => {
      const ses = opencodeSessionId("sess-123")
      for (const id of ["beam-free", "gpt-5.5"])
        expect((await capture(id)).body.prompt_cache_key).toBe(ses.slice(4))
      expect((await capture("claude-sonnet-5")).body.prompt_cache_key).toBeUndefined()
    })

    it("auth headers: Bearer on chat/responses, x-api-key or Bearer on messages", async () => {
      expect((await capture("beam-free")).headers.authorization).toBe("Bearer zen-key")
      expect((await capture("gpt-5.5")).headers.authorization).toBe("Bearer zen-key")
      const msgKey = await capture("claude-sonnet-5")
      expect(msgKey.headers["x-api-key"]).toBe("zen-key")
      expect(msgKey.headers.authorization).toBeUndefined()
      const oauth = { kind: "oauth" as const, token: "tok", headers: { "x-org-id": "org_9" } }
      const msgOAuth = await capture("claude-sonnet-5", { auth: oauth })
      expect(msgOAuth.headers.authorization).toBe("Bearer tok")
      expect(msgOAuth.headers["x-api-key"]).toBeUndefined()
      expect(msgOAuth.headers["x-org-id"]).toBe("org_9")
      const chatOAuth = await capture("beam-free", { auth: oauth })
      expect(chatOAuth.headers.authorization).toBe("Bearer tok")
      expect(chatOAuth.headers["x-org-id"]).toBe("org_9")
    })

    it("sends x-org-id for an api-key organization, not openai-organization", async () => {
      const { headers } = await capture("beam-free", {
        auth: { kind: "api-key", key: "zen-key", organization: "org_42" },
      })
      expect(headers["x-org-id"]).toBe("org_42")
      expect(headers["openai-organization"]).toBeUndefined()
    })

    it("uses the public key for free models (anonymous and empty key)", async () => {
      const anon = opencodeProviderPlugin.anonymousAuth?.()
      expect((await capture("beam-free", { auth: anon })).headers.authorization).toBe(
        "Bearer public",
      )
      expect(
        (await capture("beam-free", { auth: { kind: "api-key", key: "" } })).headers.authorization,
      ).toBe("Bearer public")
    })

    it("refuses paid models on the public key with code and hint", async () => {
      const reg = setup()
      const model = reg.resolveModel("claude-sonnet-5")
      expect(model.pricing.inputUSD).toBeGreaterThan(0)
      const run = opencodeZenAdapter.run({ modelId: model.id, messages: [userText("hi")] }, model, {
        auth: { kind: "api-key", key: "public" },
        sessionId: "s",
        networkClient: {},
      })
      const err = await run[Symbol.asyncIterator]()
        .next()
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe(ZEN_ERROR_CODES.loginRequired)
      expect((err as ProviderError).code).toBe("opencode.login_required")
      expect((err as ProviderError).hint).toBe(LOGIN_HINT)
    })

    it("renames Read to read on chat, responses, and messages", async () => {
      const req: Partial<CanonicalRequest> = {
        tools: [readTool],
        toolChoice: { type: "tool", name: "Read" },
      }
      const chat = await capture("beam-free", { req })
      const chatTools = chat.body.tools as Array<{ function: { name: string } }>
      expect(chatTools.map((t) => t.function.name)).toEqual(["read"])
      expect(JSON.stringify(chat.body.tool_choice)).toContain('"read"')
      const msgs = await capture("claude-sonnet-5", { req })
      expect((msgs.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["read"])
      const resp = await capture("gpt-5.5", { req })
      expect(JSON.stringify(resp.body.tools)).toContain('"read"')
      expect(JSON.stringify(resp.body.tools)).not.toContain('"Read"')
    })

    it("still sends a free request with no Read tool (never injects tools)", async () => {
      const { body } = await capture("beam-free")
      expect(body.tools).toBeUndefined()
    })

    it("maps a streamed read tool call back to Read", async () => {
      const reg = setup()
      const model = reg.resolveModel("beam-free")
      const chunks = [
        JSON.stringify({
          id: "c1",
          model: "m",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          id: "c1",
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
        "[DONE]",
      ]
      const networkClient = {
        async request() {
          return {
            ok: true,
            status: 200,
            body: sseBody(chunks),
            async text() {
              return ""
            },
          }
        },
      }
      const events: CanonicalEvent[] = []
      for await (const ev of opencodeZenAdapter.run(
        { modelId: model.id, messages: [userText("hi")], tools: [readTool] },
        model,
        { auth: { kind: "api-key", key: "public" }, sessionId: "s-stream", networkClient },
      ))
        events.push(ev)
      const starts = events.filter((e) => e.type === "tool_use_start")
      expect(starts).toHaveLength(1)
      expect((starts[0] as { name: string }).name).toBe("Read")
    })

    it("FreeTierError hint names the missing Read tool for that request", async () => {
      const reg = setup()
      const model = reg.resolveModel("beam-free")
      const body = JSON.stringify({
        type: "error",
        error: {
          type: "FreeTierError",
          message: "OpenCode's free tier can only be used from within OpenCode.",
        },
      })
      const networkClient = {
        async request() {
          return {
            ok: false,
            status: 403,
            async text() {
              return body
            },
          }
        },
      }
      const run = opencodeZenAdapter.run({ modelId: model.id, messages: [userText("hi")] }, model, {
        auth: { kind: "api-key", key: "public" },
        sessionId: "s",
        networkClient,
      })
      const err = (await run[Symbol.asyncIterator]()
        .next()
        .catch((e: unknown) => e)) as ProviderError
      expect(err.code).toBe("opencode.free_tier_gate")
      expect(err.hint).toContain("no Read tool")
      expect(err.hint).toContain(LOGIN_HINT)
    })
  })

  describe("taggedHttpError", () => {
    it("tags pre-stream 5xx as overloaded_error so the retry loop recovers", () => {
      const err = taggedHttpError(503, "Service Unavailable")
      expect(err.message).toBe("OpenCode Zen API 503: Service Unavailable")
      expect(err.streamErrorType).toBe("overloaded_error")
    })

    it("tags 429 as rate_limit_error", () => {
      const err = taggedHttpError(
        429,
        JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }),
      )
      expect(err.streamErrorType).toBe("rate_limit_error")
    })

    it("treats 402 and every quota code as terminal billing", () => {
      for (const code of [
        "insufficient_quota",
        "usage_not_included",
        "billing_error",
        "gousagelimiterror",
        "freeusagelimiterror",
        "creditlimitexceeded",
        "FreeUsageLimitError",
      ]) {
        for (const shape of [{ type: code }, { code }]) {
          const err = taggedHttpError(429, JSON.stringify({ error: { ...shape, message: "x" } }))
          expect(err.streamErrorType).toBeUndefined()
          expect(err.code).toBe("opencode.billing")
          expect(err.opts.retryable).toBe(false)
          expect(typeof err.hint).toBe("string")
        }
      }
      const pay = taggedHttpError(
        402,
        JSON.stringify({
          error: {
            type: "server_error",
            message: "Upstream request failed: Insufficient account funds",
          },
        }),
      )
      expect(pay.streamErrorType).toBeUndefined()
      expect(pay.code).toBe("opencode.billing")
    })

    it("reads a quota code from a [code] message label", () => {
      const err = taggedHttpError(
        429,
        JSON.stringify({
          error: { type: "x", message: "Zen: [creditlimitexceeded] out of credit" },
        }),
      )
      expect(err.code).toBe("opencode.billing")
    })

    it("FreeTierError is terminal with code and a hint", () => {
      const body = JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "m" } })
      const err = taggedHttpError(403, body, { anonymous: true, hasReadTool: true })
      expect(err.streamErrorType).toBeUndefined()
      expect(err.code).toBe("opencode.free_tier_gate")
      expect(err.message).toContain("FreeTierError")
      expect(err.hint).toContain(LOGIN_HINT)
    })

    it("426 is terminal with an upgrade hint", () => {
      const err = taggedHttpError(426, "Upgrade Required")
      expect(err.streamErrorType).toBeUndefined()
      expect(err.code).toBe("opencode.upgrade_required")
      expect(err.hint).toBe("set MINIMAL_AGENT_OPENCODE_VERSION or update opencode")
    })

    it("leaves deterministic client errors untagged (400/403/404)", () => {
      for (const status of [400, 403, 404]) {
        const err = taggedHttpError(status, "nope")
        expect(err.streamErrorType).toBeUndefined()
        expect(err.code).toBeUndefined()
      }
    })
  })
})

describe("opencode-zen hints", () => {
  it("free-tier hint does not blame a missing Read tool when the request had read", () => {
    const body = JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "x" } })
    const err = taggedHttpError(403, body, { hasReadTool: true, anonymous: true })
    expect(err.hint).not.toContain("no Read tool")
  })

  it("free usage limit for anonymous users says free tier, not add funds", () => {
    const body = JSON.stringify({ error: { type: "FreeUsageLimitError", message: "limit" } })
    const err = taggedHttpError(429, body, { anonymous: true })
    expect(err.code).toBe(ZEN_ERROR_CODES.billing)
    expect(err.hint).toContain("free")
    expect(err.hint).not.toContain("add funds")
  })
})

describe("opencode-zen auth errors", () => {
  it("adds a re-auth hint to 401 api_key_expired and keeps it untagged", () => {
    const body = JSON.stringify({
      error: { type: "authentication_error", code: "api_key_expired", message: "expired" },
    })
    const err = taggedHttpError(401, body) as ProviderError & { streamErrorType?: string }
    expect(err.code).toBe("opencode.auth")
    expect(err.hint).toContain("ma provider opencode-zen login")
    expect(err.streamErrorType).toBeUndefined()
    expect(err.opts.status).toBe(401)
  })
})

describe("opencode-zen 401 with server_error body", () => {
  it("never retries a 401, even with type server_error", () => {
    const body = JSON.stringify({
      error: { type: "server_error", message: "Upstream request failed: Invalid credential" },
    })
    const err = taggedHttpError(401, body) as ProviderError & { streamErrorType?: string }
    expect(err.streamErrorType).toBeUndefined()
    expect(err.code).toBe("opencode.auth")
  })
})

describe("Responses text.format (SPEC-ONESHOT T4c)", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } }
  const req = (outputFormat: CanonicalRequest["outputFormat"]): CanonicalRequest => ({
    modelId: "gpt-5.6-luna",
    messages: [userText("hi")],
    outputFormat,
  })

  it("sends a flat text.format and no response_format", () => {
    const model = setup().resolveModel("gpt-5.6-luna")
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "title", schema, strict: true }),
      model,
    )
    expect("response_format" in body).toBe(false)
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "title", schema, strict: true },
    })
  })

  it("gates strict on capabilities.structuredOutputs", () => {
    const base = setup().resolveModel("gpt-5.6-luna")
    const model = { ...base, capabilities: { ...base.capabilities, structuredOutputs: false } }
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "title", schema, strict: true }),
      model,
    )
    expect(body.text?.format).toEqual({ type: "json_schema", name: "title", schema })
    const loose = buildOpenAIResponsesBody(req({ type: "json_schema", name: "t", schema }), base)
    expect("strict" in (loose.text?.format ?? {})).toBe(false)
  })

  it("sanitizes the schema name", () => {
    const model = setup().resolveModel("gpt-5.6-luna")
    const bad = buildOpenAIResponsesBody(req({ type: "json_schema", name: "a b.c", schema }), model)
    expect(bad.text?.format).toMatchObject({ name: "a_b_c" })
    const long = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "x".repeat(80), schema }),
      model,
    )
    expect(long.text?.format).toMatchObject({ name: "x".repeat(64) })
    const none = buildOpenAIResponsesBody(req({ type: "json_schema", schema }), model)
    expect(none.text?.format).toMatchObject({ name: "output" })
  })

  it("maps json_object and text", () => {
    const model = setup().resolveModel("gpt-5.6-luna")
    expect(buildOpenAIResponsesBody(req({ type: "json_object" }), model).text).toEqual({
      format: { type: "json_object" },
    })
    expect(buildOpenAIResponsesBody(req({ type: "text" }), model).text).toEqual({
      format: { type: "text" },
    })
  })
})

describe("Anthropic output_config.format (SPEC-ONESHOT T4c)", () => {
  it("sends exactly {type, schema} (no name, no strict)", () => {
    const model = setup().resolveModel("claude-sonnet-5")
    const schema = { type: "object", properties: { a: { type: "string" } } }
    const body = buildAnthropicRequestBody(
      {
        modelId: "claude-sonnet-5",
        messages: [userText("hi")],
        outputFormat: { type: "json_schema", name: "title", schema, strict: true },
      },
      model,
    )
    expect(body.output_config?.format).toEqual({ type: "json_schema", schema })
  })
})
