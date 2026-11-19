/**
 * Title side call, adapter level (title SPEC §5.7 R10, item 7): the wire body
 * of a `purpose:"title"` request with `stream:false`, and the read of the
 * non-stream JSON `Message` reply. No network: a fake NetworkClient records
 * each request and answers with one JSON body. No credential: the tokens are
 * test values. The system blocks come from the provider preamble
 * (`resolveAnthropicSystemPrompt`), the same way the host side call makes
 * them (empty text blocks removed).
 *
 * @module llm/providers/anthropic/adapter.title-wire.test
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import {
  _resetCacheDiagnosisForTest,
  _resetGzipRejectedForTest,
  _setPendingAccountProbeForTest,
  anthropicAdapter,
  bootstrapAnthropic,
} from "./adapter.ts"
import { _resetIdentityForTest } from "./identity.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { messageToStreamEvents } from "./response-message.ts"
import { CLAUDE_CODE_IDENTITY, resolveAnthropicSystemPrompt } from "./system-prompt.ts"
import { useTempAgentHome } from "./test-home.ts"

useTempAgentHome()

const OAUTH: ProviderAuth = { kind: "oauth", token: "test-oauth-token" }
const API_KEY: ProviderAuth = { kind: "api-key", key: "test-api-key" }
const SESSION = "ba0ad20f-0000-4000-8000-cf4c4732fd3b"
const INSTRUCTION = "Write a short title for this session. Reply with JSON only."
const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
}

const savedGzip = process.env.MINIMAL_AGENT_NO_REQUEST_GZIP
let resolveModel: (id: string) => ModelEntry

beforeEach(() => {
  process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = "1"
  _resetIdentityForTest()
  _resetGzipRejectedForTest()
  _resetCacheDiagnosisForTest()
  _setPendingAccountProbeForTest(undefined)
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
})

afterAll(() => {
  if (savedGzip === undefined) delete process.env.MINIMAL_AGENT_NO_REQUEST_GZIP
  else process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = savedGzip
})

/** The non-stream reply of the Messages API (docs: "Returns: Message"). */
const JSON_REPLY = {
  id: "msg_title",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: '{"title":"A Great Day"}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 244, output_tokens: 14 },
}

function jsonClient(reply: unknown = JSON_REPLY): {
  client: NetworkClient
  seen: NetworkRequest[]
} {
  const seen: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      seen.push(r)
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, seen }
}

/** The host side-call system: provider preamble + the title text, no empty blocks. */
function titleSystem(auth: ProviderAuth, modelId: string): CanonicalRequest["system"] {
  return resolveAnthropicSystemPrompt({
    identity: "",
    body: [{ type: "text", text: INSTRUCTION }],
    authKind: auth.kind,
    modelId,
  })
    .filter((b) => b.text.length > 0)
    .map((b) => ({ type: "text" as const, text: b.text }))
}

function titleRequest(auth: ProviderAuth, modelId = "claude-haiku-5-5"): CanonicalRequest {
  const rec = anthropicAdapter.recommendUtilityModel()
  return {
    modelId,
    purpose: "title",
    stream: rec?.stream !== "off",
    system: titleSystem(auth, modelId),
    messages: [{ role: "user", content: [{ type: "text", text: "<session>\nhi\n</session>" }] }],
    generation: { maxOutputTokens: 256 },
    thinking: { mode: "off" },
    ...(rec?.effort ? { effort: rec.effort } : {}),
    outputFormat: { type: "json_schema", schema: SCHEMA },
  }
}

async function run(
  req: CanonicalRequest,
  client: NetworkClient,
  auth: ProviderAuth,
): Promise<CanonicalEvent[]> {
  const ctx: RunContext = { auth, sessionId: SESSION, networkClient: client }
  const out: CanonicalEvent[] = []
  for await (const ev of anthropicAdapter.run!(req, resolveModel(req.modelId), ctx)) out.push(ev)
  return out
}

// biome-ignore lint/suspicious/noExplicitAny: wire JSON under test
const bodyOf = (r: NetworkRequest | undefined): any => JSON.parse(r!.body as string)
const betasOf = (r: NetworkRequest | undefined): string[] =>
  (r!.headers?.["anthropic-beta"] ?? "").split(",").filter(Boolean)

function textOf(events: CanonicalEvent[]): string {
  return events
    .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("")
}

function stopOf(events: CanonicalEvent[]): Extract<CanonicalEvent, { type: "message_delta" }> {
  const ev = events.find((e) => e.type === "message_delta")
  if (ev?.type !== "message_delta") throw new Error("no message_delta")
  return ev
}

describe("title side call: plan OAuth wire body", () => {
  it("system = [billing header, Claude Code identity, title text]; minimal body", async () => {
    const { client, seen } = jsonClient()
    await run(titleRequest(OAUTH), client, OAUTH)
    expect(seen).toHaveLength(1)
    const body = bodyOf(seen[0])

    expect(body.system).toHaveLength(3)
    expect(body.system[0].text).toStartWith("x-anthropic-billing-header:")
    expect(body.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(body.system[2].text).toBe(INSTRUCTION)

    expect(body.tools).toBeUndefined()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe("user")
    expect(body.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    })
    expect(body.max_tokens).toBe(256)
    expect(body.stream).toBe(false)
    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.context_management).toBeUndefined()
    expect(betasOf(seen[0]).some((b) => b.startsWith("oauth-"))).toBe(true)
  })

  it("reads the non-stream JSON reply: text, end_turn and usage", async () => {
    const { client } = jsonClient()
    const events = await run(titleRequest(OAUTH), client, OAUTH)
    expect(textOf(events)).toBe('{"title":"A Great Day"}')
    const stop = stopOf(events)
    expect(stop.stopReason).toBe("end_turn")
    expect(stop.usage.inputTokens).toBe(244)
    expect(stop.usage.outputTokens).toBe(14)
    expect(events.at(-1)?.type).toBe("message_stop")
  })
})

describe("title side call: API-key wire body", () => {
  it("system = [title text] only (no billing, no Claude Code identity); same minimal body", async () => {
    const { client, seen } = jsonClient()
    await run(titleRequest(API_KEY), client, API_KEY)
    const body = bodyOf(seen[0])

    expect(body.system).toEqual([{ type: "text", text: INSTRUCTION }])
    expect(body.tools).toBeUndefined()
    expect(body.messages).toHaveLength(1)
    expect(body.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    })
    expect(body.max_tokens).toBe(256)
    expect(body.stream).toBe(false)
    expect(body.context_management).toBeUndefined()
    expect(body.metadata).toBeUndefined()
    expect(betasOf(seen[0]).some((b) => b.startsWith("oauth-"))).toBe(false)
  })

  it("reads the non-stream JSON reply", async () => {
    const { client } = jsonClient()
    const events = await run(titleRequest(API_KEY), client, API_KEY)
    expect(textOf(events)).toBe('{"title":"A Great Day"}')
    expect(stopOf(events).stopReason).toBe("end_turn")
  })

  it("Haiku 4.5 (no adaptive thinking): no thinking field, same other fields", async () => {
    const { client, seen } = jsonClient()
    await run(titleRequest(API_KEY, "claude-haiku-4-5-20251001"), client, API_KEY)
    const body = bodyOf(seen[0])
    expect(body.thinking).toBeUndefined()
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(256)
  })
})

describe("non-stream reply edge cases", () => {
  it("a max_tokens stop comes through (the plugin then rejects the title)", async () => {
    const { client } = jsonClient({ ...JSON_REPLY, stop_reason: "max_tokens" })
    const events = await run(titleRequest(API_KEY), client, API_KEY)
    expect(stopOf(events).stopReason).toBe("max_tokens")
  })

  it("a stream:false request with an SSE reply still reads the SSE", async () => {
    const enc = new TextEncoder()
    const ev = (name: string, data: unknown) =>
      enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    const client = {
      request: async (): Promise<NetworkResponse> =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                ev("message_start", {
                  type: "message_start",
                  message: { id: "m", model: "claude-haiku-5-5", usage: { input_tokens: 1 } },
                }),
              )
              c.enqueue(
                ev("content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                }),
              )
              c.enqueue(
                ev("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "sse" },
                }),
              )
              c.enqueue(ev("message_stop", { type: "message_stop" }))
              c.close()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ) as unknown as NetworkResponse,
    } as NetworkClient
    const events = await run(titleRequest(API_KEY), client, API_KEY)
    expect(textOf(events)).toBe("sse")
  })

  it("an error body gives one error event", () => {
    const events = messageToStreamEvents({
      type: "error",
      error: { type: "overloaded_error", message: "busy" },
    })
    expect(events).toEqual([
      { type: "error", error: { type: "overloaded_error", message: "busy" } },
    ])
  })

  it("thinking and tool_use blocks keep their order and data", () => {
    const events = messageToStreamEvents({
      id: "m",
      model: "x",
      content: [
        { type: "thinking", thinking: "t", signature: "s" },
        { type: "tool_use", id: "tu", name: "n", input: { a: 1 } },
        { type: "server_tool_use" },
      ],
      stop_reason: "tool_use",
    })
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(events[4]).toEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":1}' },
    })
  })
})
