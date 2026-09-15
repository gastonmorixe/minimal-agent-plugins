/**
 * Grok provider prime/session tests (offline) — split from grok.test.ts.
 *
 * @module llm/providers/grok/grok-prime.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { bootstrapGrok, grokAdapter } from "./adapter.ts"
import { type CanonicalEvent, isEvent } from "./lib/canonical-events.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./lib/openai-chat.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerGrokModels } from "./models.ts"
import {
  _resetGrokPrimeInFlight,
  clearGrokSessionCaches,
  fetchGrokSessionInfo,
  getGrokBillingQuota,
  primeGrokSessionInfo,
} from "./session-info.ts"
import { grokChatCompletionsCodec } from "./surface-codecs.ts"
import { CLI_BILLING_URL, CLI_MODELS_URL } from "./wire-constants.ts"

let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapGrok({ models: reg.models, providers: reg.providers })
}

function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}
const openaiChatPong = () =>
  readFileSync(join(import.meta.dir, "__fixtures__/chat-pong.sse"), "utf-8")

describe("llm-grok provider plugin (prime/session)", () => {
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
      expect(ids).toEqual(["month"])
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
    expect(recs.find((r) => r.role === "deep")?.modelId).toBe("grok-4.6")
    expect(recs.find((r) => r.role === "scout")?.modelId).toBe("grok-4.3")
    // grok-build lost "balanced" in the 2026-08-21 catalog refresh (it is a
    // specialized coding SKU); grok-build-chat carries balanced+code now.
    expect(recs.find((r) => r.role === "balanced")?.modelId).toBe("grok-build-chat")
  })

  it("exposes a chat surface codec for generic-endpoint reuse", () => {
    expect(grokChatCompletionsCodec.surfaceId).toBe("openai-chat-completions")
    expect(grokChatCompletionsCodec.defaultPath).toBe("/v1/chat/completions")
    expect(grokChatCompletionsCodec.defaultCapabilities.modalities.image).toBe(true)
  })

  it("registerGrokModels returns dual-surface catalog size", () => {
    setup()
    const ids = registerGrokModels(reg.models)
    // 2×4.6 + 2×4.5 + 2×build + 2×4.3 + 3×4.20 = 11
    expect(ids.length).toBe(11)
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
