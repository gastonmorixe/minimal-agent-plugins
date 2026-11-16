/**
 * Adapter-level claude-code 2.1.325 parity for research diff B1, B2, B7 and B5:
 * context-1m gating per model, the mid-conversation-system-clear-at beta and
 * its one-shot heal, OAuth `metadata.user_id`, and the opt-in
 * `thinking.display:"updates"`. No network, no credentials: a fake
 * NetworkClient records each request. The config file is pointed at a temp
 * path (MINIMAL_AGENT_CONFIG) so the real user config never leaks in.
 *
 * @module llm/providers/anthropic/adapter.cc-wire-options.test
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import {
  _resetCacheDiagnosisForTest,
  _resetClearAtRejectedForTest,
  _resetGzipRejectedForTest,
  _setPendingAccountProbeForTest,
  ACCOUNT_PROBE_WAIT_MS,
  anthropicAdapter,
  bootstrapAnthropic,
  isClearAtRejection,
} from "./adapter.ts"
import { _resetIdentityForTest, getOwnDeviceId, rememberAccountUuid } from "./identity.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { readAnthropicOAuthAuth } from "./oauth-login.ts"
import { _resetWireOptionsForTest, resolveWireOptions } from "./wire-options.ts"

const OAUTH: ProviderAuth = { kind: "oauth", token: "sk-ant-oat01-test" }
const API_KEY: ProviderAuth = { kind: "api-key", key: "sk-ant-api-test" }
const SESSION = "ba0ad20f-0000-4000-8000-cf4c4732fd3b"
const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

const CONTEXT_1M = "context-1m-2025-08-07"
const CLEAR_AT = "mid-conversation-system-clear-at-2026-08-21"
const MID_CONV_OLD = "mid-conversation-system-2026-04-07"
const DISPLAY_UPDATES = "thinking-display-updates-2026-08-18"

const tmp = mkdtempSync(join(tmpdir(), "ma-anthropic-wire-opts-"))
const configFile = join(tmp, "config.jsonc")
const ENV_KEYS = [
  "MINIMAL_AGENT_CONFIG",
  "MINIMAL_AGENT_NO_METADATA_USER_ID",
  "MINIMAL_AGENT_THINKING_DISPLAY",
  "MINIMAL_AGENT_NO_REQUEST_GZIP",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let resolveModel: (id: string) => ModelEntry

beforeEach(() => {
  process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = "1"
  process.env.MINIMAL_AGENT_CONFIG = configFile
  delete process.env.MINIMAL_AGENT_NO_METADATA_USER_ID
  delete process.env.MINIMAL_AGENT_THINKING_DISPLAY
  rmSync(configFile, { force: true })
  _resetWireOptionsForTest()
  _resetIdentityForTest()
  _resetGzipRejectedForTest()
  _resetCacheDiagnosisForTest()
  _resetClearAtRejectedForTest()
  _setPendingAccountProbeForTest(undefined)
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  _resetWireOptionsForTest()
  rmSync(tmp, { recursive: true, force: true })
})

function writeConfig(anthropic: Record<string, unknown>): void {
  writeFileSync(configFile, `// test config\n${JSON.stringify({ plugins: { anthropic } })}\n`)
  _resetWireOptionsForTest()
}

type Reply = { status: number; body: string } | undefined

function sse(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const ev = (name: string, data: unknown) =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  return new ReadableStream({
    start(c) {
      c.enqueue(
        ev("message_start", {
          type: "message_start",
          message: {
            id: "msg_x",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
      )
      c.enqueue(ev("message_stop", { type: "message_stop" }))
      c.close()
    },
  })
}

function recorder(script: Reply[] = []): { client: NetworkClient; seen: NetworkRequest[] } {
  const seen: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      seen.push(r)
      const step = script[seen.length - 1]
      if (step) {
        return {
          ok: false,
          status: step.status,
          headers: new Headers(),
          body: null,
          text: async () => step.body,
        } as unknown as NetworkResponse
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sse(),
        text: async () => "",
      } as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, seen }
}

/** Conversation-shaped request (2 tools → kind "conversation"). */
function conversation(modelId: string, extra?: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      { name: "a", description: "", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
    ],
    ...extra,
  }
}

async function run(
  req: CanonicalRequest,
  client: NetworkClient,
  auth: ProviderAuth = OAUTH,
): Promise<void> {
  const ctx: RunContext = { auth, sessionId: SESSION, networkClient: client }
  for await (const _ of anthropicAdapter.run!(req, resolveModel(req.modelId), ctx)) {
    // drain
  }
}

const betasOf = (r: NetworkRequest | undefined): string[] =>
  (r!.headers?.["anthropic-beta"] ?? "").split(",")
// biome-ignore lint/suspicious/noExplicitAny: wire JSON under test
const bodyOf = (r: NetworkRequest | undefined): any => JSON.parse(r!.body as string)

describe("B1: context-1m only for non-native 1M models", () => {
  it("opus-5-5 conversation (CC native_1m) → no context-1m", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(betasOf(seen[0])).not.toContain(CONTEXT_1M)
  })

  it("sonnet-4-6 (beta-gated 1M) → context-1m still sent", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-sonnet-4-6"), client)
    expect(betasOf(seen[0])).toContain(CONTEXT_1M)
  })

  it("fable-5 keeps context-1m (fable-5 P0 guard)", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-fable-5"), client)
    expect(betasOf(seen[0])).toContain(CONTEXT_1M)
  })
})

describe("B2: mid-conversation-system-clear-at + one-shot heal", () => {
  const rejection = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `Unexpected value(s) \`${CLEAR_AT}\` for the \`anthropic-beta\` header.`,
    },
  })

  it("sends clear-at, never the retired header", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(betasOf(seen[0])).toContain(CLEAR_AT)
    expect(betasOf(seen[0])).not.toContain(MID_CONV_OLD)
  })

  it("on a 400 naming clear-at, retries once with the old header and latches it", async () => {
    const { client, seen } = recorder([{ status: 400, body: rejection }])
    await run(conversation("claude-opus-5-5"), client)
    expect(seen).toHaveLength(2)
    expect(betasOf(seen[1])).not.toContain(CLEAR_AT)
    expect(betasOf(seen[1])).toContain(MID_CONV_OLD)
    await run(conversation("claude-opus-5-5"), client)
    expect(betasOf(seen[2])).toContain(MID_CONV_OLD)
    expect(betasOf(seen[2])).not.toContain(CLEAR_AT)
  })

  it("after the latch, the old header goes only where clear-at would have gone", async () => {
    const { client, seen } = recorder([{ status: 400, body: rejection }])
    await run(conversation("claude-opus-5-5"), client)
    expect(betasOf(seen[1])).toContain(MID_CONV_OLD)
    // Title / quota probes never carry clear-at, so no fallback header either.
    const title: CanonicalRequest = {
      modelId: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "title me" }] }],
      purpose: "title",
    }
    const quota: CanonicalRequest = {
      modelId: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "quota" }] }],
      generation: { maxOutputTokens: 1 },
    }
    await run(title, client)
    await run(quota, client)
    for (const r of seen.slice(2)) {
      expect(betasOf(r)).not.toContain(MID_CONV_OLD)
      expect(betasOf(r)).not.toContain(CLEAR_AT)
    }
    // A model without mid-conversation system support gets neither.
    await run(conversation("claude-haiku-4-5-20251001"), client)
    expect(betasOf(seen[4])).not.toContain(MID_CONV_OLD)
  })

  it("does not heal twice: a second clear-at 400 surfaces as an error", async () => {
    const { client, seen } = recorder([
      { status: 400, body: rejection },
      { status: 400, body: rejection },
    ])
    await expect(run(conversation("claude-opus-5-5"), client)).rejects.toThrow(/400/)
    expect(seen).toHaveLength(2)
  })

  it("an unrelated 400 does not trigger the heal", async () => {
    const { client, seen } = recorder([{ status: 400, body: '{"error":{"message":"nope"}}' }])
    await expect(run(conversation("claude-opus-5-5"), client)).rejects.toThrow(/400/)
    expect(seen).toHaveLength(1)
  })

  it("matches CC's mCn shapes", () => {
    expect(isClearAtRejection(400, rejection)).toBe(true)
    expect(
      isClearAtRejection(
        400,
        JSON.stringify({
          error: { message: "messages.3.clear_at: Extra inputs are not permitted" },
        }),
      ),
    ).toBe(true)
    expect(isClearAtRejection(400, "Unexpected value(s) `effort-2025-11-24` anthropic-beta")).toBe(
      false,
    )
    expect(isClearAtRejection(500, rejection)).toBe(false)
  })
})

describe("B7: OAuth metadata.user_id", () => {
  it("is present by default with CC's JSON shape and key order", async () => {
    rememberAccountUuid(ACCOUNT)
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    const userId = bodyOf(seen[0]).metadata.user_id as string
    expect(typeof userId).toBe("string")
    const parsed = JSON.parse(userId)
    expect(Object.keys(parsed)).toEqual(["device_id", "account_uuid", "session_id"])
    expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.account_uuid).toBe(ACCOUNT)
    expect(parsed.session_id).toBe(SESSION)
    expect(userId).not.toContain(" ")
  })

  it('keeps account_uuid as an empty string when unknown (CC `||""`)', async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(JSON.parse(bodyOf(seen[0]).metadata.user_id).account_uuid).toBe("")
  })

  it("E2E FAIL-1: first request carries the stored credential's account uuid", async () => {
    // Core reads the credential through readAuth before the first send.
    const auth = readAnthropicOAuthAuth({ accessToken: "sk-ant-oat01-seed", accountUuid: ACCOUNT })
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client, auth!)
    expect(JSON.parse(bodyOf(seen[0]).metadata.user_id).account_uuid).toBe(ACCOUNT)
  })

  it("no stored uuid: the first send waits for the in-flight bootstrap probe", async () => {
    _setPendingAccountProbeForTest(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          rememberAccountUuid(ACCOUNT)
          resolve()
        }, 30),
      ),
    )
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(JSON.parse(bodyOf(seen[0]).metadata.user_id).account_uuid).toBe(ACCOUNT)
  })

  it("a stuck probe delays the first send by at most the wait cap", async () => {
    _setPendingAccountProbeForTest(new Promise<void>(() => {}))
    const { client, seen } = recorder()
    const t0 = Date.now()
    await run(conversation("claude-opus-5-5"), client)
    const waited = Date.now() - t0
    expect(ACCOUNT_PROBE_WAIT_MS).toBeLessThanOrEqual(1500)
    expect(waited).toBeGreaterThanOrEqual(ACCOUNT_PROBE_WAIT_MS - 50)
    expect(waited).toBeLessThan(ACCOUNT_PROBE_WAIT_MS + 1000)
    expect(JSON.parse(bodyOf(seen[0]).metadata.user_id).account_uuid).toBe("")
  })

  it("no wait when the uuid is already known (seeded credential)", async () => {
    _setPendingAccountProbeForTest(new Promise<void>(() => {}))
    const auth = readAnthropicOAuthAuth({ accessToken: "sk-ant-oat01-seed2", accountUuid: ACCOUNT })
    const { client } = recorder()
    const t0 = Date.now()
    await run(conversation("claude-opus-5-5"), client, auth!)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it("device_id is stable across requests", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    await run(conversation("claude-opus-5-5"), client)
    const a = JSON.parse(bodyOf(seen[0]).metadata.user_id).device_id
    const b = JSON.parse(bodyOf(seen[1]).metadata.user_id).device_id
    expect(a).toBe(b)
  })

  it("is absent with MINIMAL_AGENT_NO_METADATA_USER_ID=1", async () => {
    process.env.MINIMAL_AGENT_NO_METADATA_USER_ID = "1"
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(bodyOf(seen[0]).metadata).toBeUndefined()
  })

  it("is absent with plugins.anthropic.metadataUserId:false", async () => {
    writeConfig({ metadataUserId: false })
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(bodyOf(seen[0]).metadata).toBeUndefined()
  })

  it("is never sent in api-key mode", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client, API_KEY)
    expect(bodyOf(seen[0]).metadata).toBeUndefined()
  })

  it("persists our own device id (never ~/.claude.json) and reuses it", () => {
    const path = join(tmp, "state", "device.json")
    const id = getOwnDeviceId(path)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(readFileSync(path, "utf8")).deviceId).toBe(id)
    _resetIdentityForTest()
    expect(getOwnDeviceId(path)).toBe(id)
  })
})

describe("B5: opt-in thinking.display updates", () => {
  it("default: no display field and no beta", async () => {
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(bodyOf(seen[0]).thinking).toEqual({ type: "adaptive" })
    expect(betasOf(seen[0])).not.toContain(DISPLAY_UPDATES)
  })

  it("MINIMAL_AGENT_THINKING_DISPLAY=updates: display + beta", async () => {
    process.env.MINIMAL_AGENT_THINKING_DISPLAY = "updates"
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(bodyOf(seen[0]).thinking).toEqual({ type: "adaptive", display: "updates" })
    expect(betasOf(seen[0])).toContain(DISPLAY_UPDATES)
  })

  it('plugins.anthropic.thinkingDisplay:"updates": display + beta', async () => {
    writeConfig({ thinkingDisplay: "updates" })
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5"), client)
    expect(bodyOf(seen[0]).thinking).toEqual({ type: "adaptive", display: "updates" })
    expect(betasOf(seen[0])).toContain(DISPLAY_UPDATES)
  })

  it("opt-in is ignored for a model without adaptive thinking", async () => {
    process.env.MINIMAL_AGENT_THINKING_DISPLAY = "updates"
    const { client, seen } = recorder()
    await run(conversation("claude-haiku-4-5-20251001"), client)
    expect(bodyOf(seen[0]).thinking).toBeUndefined()
    expect(betasOf(seen[0])).not.toContain(DISPLAY_UPDATES)
  })

  it("opt-in is ignored when the request turns thinking off", async () => {
    process.env.MINIMAL_AGENT_THINKING_DISPLAY = "updates"
    const { client, seen } = recorder()
    await run(conversation("claude-opus-5-5", { thinking: { mode: "off" } }), client)
    expect(bodyOf(seen[0]).thinking).toBeUndefined()
    expect(betasOf(seen[0])).not.toContain(DISPLAY_UPDATES)
  })
})

describe("wire-options config parsing", () => {
  it("falls back to defaults on wrong types", () => {
    expect(resolveWireOptions({ plugins: { anthropic: { metadataUserId: "no" } } })).toEqual({
      metadataUserId: true,
    })
    expect(resolveWireOptions(null)).toEqual({ metadataUserId: true })
    expect(
      resolveWireOptions({ plugins: { anthropic: { thinkingDisplay: "summarized" } } }),
    ).toEqual({ metadataUserId: true })
  })
})
