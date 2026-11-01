/**
 * Thinking history after a same-provider model switch (ACP A3, handoff 5.4).
 *
 * The test drives the real path with no network. Core's `AgentCore` is built
 * through the production factory (`testing/test-core`). It sends through the
 * canonical transport and this plugin's real adapter. A fake `NetworkClient`
 * records each request body and replays canned Anthropic SSE.
 *
 * Turn 1 runs on model A and returns a signed thinking block plus text. Then
 * `setModel(B)` switches to another Anthropic model. Turn 2 must send the
 * thinking block back byte for byte (text and signature), with the thinking
 * and effort config of model B.
 *
 * Provider rule (Anthropic Messages API, current docs, "Preserved thinking"
 * and the model migration guide): pass thinking blocks back unchanged on
 * every request, also after a model switch. The API drops, with no charge,
 * each block that the target model cannot read. Do not strip blocks on the
 * client: that can cause ordering or signature 400s, and a kept block is read
 * again when the conversation goes back to a model that can read it. So the
 * correct behavior is "keep".
 *
 * The test lives in this repo, not in core: core's provider-decoupling
 * ratchet forbids provider ids in core code, tests included.
 */

import { Buffer } from "node:buffer"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
  type SecretBag,
} from "@minimal-agent/core/host/auth-store"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/host/network"
import { bootProviderDiscovery } from "@minimal-agent/core/host/provider-discovery-boot"
import { clearProviderPlugins, findProviderPlugin } from "@minimal-agent/core/host/provider-plugin"
import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"

import { anthropicAdapter } from "./adapter.ts"

const MODEL_A = "claude-opus-4-8"
const MODEL_B = "claude-opus-4-7"
const THOUGHT = "Plan: answer in one word."
const TOKEN = "sk-ant-oat-test-switch"
const AUTH: AuthResult = { type: "oauth", token: TOKEN }

/**
 * A fake signature with the same layout as a real one: field 6 (tag 0x32)
 * holds the model id inside an outer length-delimited field. The adapter's
 * `extractModelFromSignature` reads the model id from it.
 */
function fakeSignature(modelId: string): string {
  const id = Buffer.from(modelId, "utf8")
  const inner = Buffer.concat([Buffer.from([0x32, id.length]), id, Buffer.from([0x3a, 2, 7, 9])])
  return Buffer.concat([Buffer.from([0x12, inner.length]), inner]).toString("base64")
}

function sse(events: object[]): NetworkResponse {
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("")
  const bytes = new TextEncoder().encode(text)
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_switch" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  })
}

function messageStart(model: string): object {
  return {
    type: "message_start",
    message: {
      model,
      id: `msg_${model}`,
      type: "message",
      role: "assistant",
      content: [],
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }
}

const MESSAGE_END: object[] = [
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  { type: "message_stop" },
]

/** Turn 1: one signed thinking block, then text. */
function thinkingTurn(model: string, signature: string): object[] {
  return [
    messageStart(model),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THOUGHT } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Yes." } },
    { type: "content_block_stop", index: 1 },
    ...MESSAGE_END,
  ]
}

function textTurn(model: string): object[] {
  return [
    messageStart(model),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    ...MESSAGE_END,
  ]
}

interface WireBody {
  model: string
  thinking?: { type: string }
  output_config?: { effort?: string }
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
}

/** A NetworkClient that records the JSON body of each Messages request. */
function recordingClient(replies: NetworkResponse[]): {
  client: NetworkClient
  bodies: WireBody[]
} {
  const bodies: WireBody[] = []
  const client = new NetworkClient({
    primary: {
      id: "fake",
      request: async (req: NetworkRequest) => {
        // Side requests (for example the OAuth bootstrap probe) are not under test.
        if (!new URL(req.url).pathname.endsWith("/v1/messages")) {
          return new NetworkResponse({ status: 404, headers: {}, transport: { id: "fake" } })
        }
        const raw = req.capture?.requestBody ?? (typeof req.body === "string" ? req.body : "")
        bodies.push(JSON.parse(raw) as WireBody)
        const next = replies.shift()
        if (!next) throw new Error("no canned reply left")
        return next
      },
    },
  })
  return { client, bodies }
}

async function drain(gen: AsyncGenerator<unknown, unknown, undefined>): Promise<void> {
  while (!(await gen.next()).done) {
    // Read every event. The test checks the recorded requests only.
  }
}

/** Store an OAuth credential with the plugin's own credential builder. */
function seedCredential(): void {
  const login = findProviderPlugin("anthropic")?.oauthLogin
  if (!login) throw new Error("anthropic plugin has no oauthLogin")
  const write = login.buildCredential({
    access_token: TOKEN,
    refresh_token: `${TOKEN}-refresh`,
    expires_in: 3600,
    scope: "user:inference",
  })
  const { serviceId, displayName, secrets } = write.credential
  defaultAuthStore().set(serviceId, displayName, secrets as SecretBag)
}

const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
let workDir = ""

describe("thinking history after setModel (real Anthropic adapter, AgentCore)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "ma-anthropic-thinking-switch-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(workDir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    // Discover ONLY this plugin, so the test proves this adapter alone.
    mkdirSync(join(workDir, "plugins"))
    symlinkSync(import.meta.dir, join(workDir, "plugins", "ma-llm-anthropic-plugin"))
    await bootProviderDiscovery({ roots: [join(workDir, "plugins")] })
    seedCredential()
  })

  afterAll(() => {
    clearProviderPlugins()
    clearModelRegistry()
    clearProviderRegistry()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    resetDefaultAuthStoreForTests()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it("keeps model A's signed thinking block unchanged in the turn-2 request to model B", async () => {
    const signature = fakeSignature(MODEL_A)
    const { client, bodies } = recordingClient([
      sse(thinkingTurn(MODEL_A, signature)),
      sse(textTurn(MODEL_B)),
    ])
    // Turn notices are `notice` events (core S37). Collect them from the sink.
    const notices: TurnNotice[] = []
    const core = await buildTestCore({
      auth: AUTH,
      model: MODEL_A,
      providerId: "anthropic",
      networkClient: client,
      eventSink: {
        emit: (e) => {
          if (e.type === "notice") notices.push(e.notice)
        },
      },
    })

    await drain(core.run("Question one?"))
    core.setModel(MODEL_B)
    await drain(core.run("Question two?"))

    expect(bodies).toHaveLength(2)
    const [first, second] = bodies as [WireBody, WireBody]
    expect(first.model).toBe(MODEL_A)
    expect(second.model).toBe(MODEL_B)

    // The turn-1 assistant message goes back with the thinking block first,
    // byte for byte: same text, same signature (signed by model A).
    const assistant = second.messages.find((m) => m.role === "assistant")
    const blocks = assistant?.content ?? []
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text"])
    expect(blocks[0]).toEqual({ type: "thinking", thinking: THOUGHT, signature })

    // Thinking and effort config come from model B.
    expect(second.thinking).toEqual({ type: "adaptive" })
    expect(typeof second.output_config?.effort).toBe("string")

    // The switch is safe, so the adapter raises no preflight issue. No ask is
    // denied, and the request goes out unchanged (the provider rule).
    expect(notices.filter((n) => n.kind === "ask_denied")).toEqual([])
  })

  it("never asks the user about the switch, also when an askUser port is set", async () => {
    const signature = fakeSignature(MODEL_A)
    const { client, bodies } = recordingClient([
      sse(thinkingTurn(MODEL_A, signature)),
      sse(textTurn(MODEL_B)),
    ])
    const core = await buildTestCore({
      auth: AUTH,
      model: MODEL_A,
      providerId: "anthropic",
      networkClient: client,
    })
    let asks = 0
    const askUser = async (): Promise<string | null> => {
      asks++
      return "strip"
    }

    await drain(core.run("Question one?", { askUser }))
    core.setModel(MODEL_B)
    await drain(core.run("Question two?", { askUser }))

    expect(asks).toBe(0)
    const assistant = (bodies[1] as WireBody).messages.find((m) => m.role === "assistant")
    expect(assistant?.content[0]).toEqual({ type: "thinking", thinking: THOUGHT, signature })
  })

  it("has no preflight hook that can ask a person", () => {
    expect(anthropicAdapter.preflight).toBeUndefined()
    expect(anthropicAdapter.applyResolution).toBeUndefined()
  })

  it("drops an effort that model B does not support before the turn-2 request", async () => {
    const { client, bodies } = recordingClient([
      sse(thinkingTurn(MODEL_A, fakeSignature(MODEL_A))),
      sse(textTurn("claude-sonnet-4-6")),
    ])
    const core = await buildTestCore({
      auth: AUTH,
      model: MODEL_A,
      providerId: "anthropic",
      networkClient: client,
    })
    core.setEffort("xhigh")

    await drain(core.run("Question one?"))
    core.setModel("claude-sonnet-4-6")
    await drain(core.run("Question two?"))

    const [first, second] = bodies as [WireBody, WireBody]
    expect(first.output_config?.effort).toBe("xhigh")
    // Sonnet 4.6 has no "xhigh" level. The core drops it, and the adapter
    // sends the model default instead of a value the API rejects.
    expect(second.model).toBe("claude-sonnet-4-6")
    expect(second.output_config?.effort).not.toBe("xhigh")
    const assistant = second.messages.find((m) => m.role === "assistant")
    expect(assistant?.content[0]).toMatchObject({ type: "thinking", thinking: THOUGHT })
  })
})
