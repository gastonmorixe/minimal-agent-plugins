/**
 * Thinking history after a same-provider model switch on the Responses
 * surface (ACP A3, handoff 5.4).
 *
 * The test drives the real path with no network. Core's `AgentCore` is built
 * through the production factory (`testing/test-core`). It sends through the
 * canonical transport and this plugin's real adapter. A fake `NetworkClient`
 * records each request body and replays canned Responses SSE.
 *
 * Turn 1 on model A returns a reasoning summary plus text. Then `setModel(B)`
 * switches to another OpenAI model. The Responses request builder has no
 * input form for thinking, so the turn-2 request must carry no reasoning item
 * and no reasoning text from model A. A foreign reasoning item can therefore
 * never reach model B.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

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
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"

import { buildOpenAIApiKeyCredential } from "./auth.ts"

const MODEL_A = "gpt-6-sol"
const MODEL_B = "gpt-6-luna"
const KEY = "sk-openai-test-switch"
const THOUGHT = "Plan: answer in one word."

function sse(events: object[]): NetworkResponse {
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("")
  const bytes = new TextEncoder().encode(text)
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "req_switch" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  })
}

/** One Responses turn: an optional reasoning item with a summary, then text. */
function responsesTurn(model: string, withReasoning: boolean): object[] {
  const id = `resp_${model}`
  const events: object[] = [{ type: "response.created", response: { id, model } }]
  if (withReasoning) {
    events.push(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: THOUGHT },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", text: THOUGHT },
    )
  }
  const part = { item_id: "msg_1", output_index: 1, content_index: 0 }
  events.push(
    { type: "response.content_part.added", ...part, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", ...part, delta: "Yes." },
    { type: "response.output_text.done", ...part, text: "Yes." },
    {
      type: "response.completed",
      response: { id, model, usage: { input_tokens: 10, output_tokens: 5 } },
    },
  )
  return events
}

interface WireBody {
  model: string
  input: Array<{ type?: string }>
}

/** A NetworkClient that records the JSON body of each Responses request. */
function recordingClient(replies: NetworkResponse[]): {
  client: NetworkClient
  bodies: WireBody[]
} {
  const bodies: WireBody[] = []
  const client = new NetworkClient({
    primary: {
      id: "fake",
      request: async (req: NetworkRequest) => {
        if (!new URL(req.url).pathname.endsWith("/responses")) {
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

const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
let workDir = ""

describe("thinking history after setModel (real OpenAI Responses adapter, AgentCore)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "ma-openai-thinking-switch-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(workDir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    // Discover ONLY this plugin, so no other provider owns these model ids.
    mkdirSync(join(workDir, "plugins"))
    symlinkSync(import.meta.dir, join(workDir, "plugins", "ma-llm-openai-plugin"))
    await bootProviderDiscovery({ embeddedDir: workDir })
    const write = buildOpenAIApiKeyCredential(KEY)
    defaultAuthStore().set(write.serviceId, write.displayName, write.secrets as SecretBag)
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

  it("sends no reasoning item from model A in the turn-2 request to model B", async () => {
    const { client, bodies } = recordingClient([
      sse(responsesTurn(MODEL_A, true)),
      sse(responsesTurn(MODEL_B, false)),
    ])
    const core = await buildTestCore({
      auth: { type: "api-key", token: KEY },
      model: MODEL_A,
      providerId: "openai",
      networkClient: client,
    })

    await drain(core.run("Question one?"))
    core.setModel(MODEL_B)
    await drain(core.run("Question two?"))

    expect(bodies).toHaveLength(2)
    const second = bodies[1] as WireBody
    expect(second.model).toBe(MODEL_B)
    // Turn 1's answer text goes back, but no reasoning from model A does.
    expect(JSON.stringify(second.input)).toContain("Yes.")
    expect(second.input.some((item) => item.type === "reasoning")).toBe(false)
    expect(JSON.stringify(second.input)).not.toContain(THOUGHT)
  })
})
