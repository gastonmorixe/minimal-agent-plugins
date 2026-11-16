/**
 * CC 2.1.325 parity, step 2:
 * - diagnostics.previous_message_id from core's `providerMessageId` (CC
 *   `Amt`/`ice`), fingerprint map only as a fallback (./cache-diagnosis.ts);
 * - the four header-only betas and their "invalid beta flag" heals;
 * - the `x-claude-code-request-class` / `x-claude-1p-request-class` headers.
 *
 * Evidence: research/2026-11-15-cc-2.1.325-oauth-diff/betas-headers.md.
 * No network, no credentials: a fake NetworkClient records each request.
 * NODE_ENV=test keeps identity.ts's device id in memory (no ~/.minimal-agent write).
 *
 * @module llm/providers/anthropic/adapter.cc-2-1-325-betas.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
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
  anthropicAdapter,
  bootstrapAnthropic,
} from "./adapter.ts"
import { ANTHROPIC_BETA_FLAGS as F } from "./beta-flags.ts"
import { CC_PER_TURN_EFFORT_MODELS, wantsPerTurnControl } from "./beta-gates.ts"
import { forgetMessageId, previousMessageIdFor } from "./cache-diagnosis.ts"
import {
  buildAnthropicHeaders,
  FIRST_PARTY_REQUEST_CLASS_HEADER,
  REQUEST_CLASS_HEADER,
} from "./headers.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { useTempAgentHome } from "./test-home.ts"

useTempAgentHome()

const OAUTH: ProviderAuth = { kind: "oauth", token: "sk-ant-oat01-test" }

let resolveModel: (id: string) => ModelEntry

beforeEach(() => {
  process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = "1"
  delete process.env.MINIMAL_AGENT_NO_CACHE_DIAGNOSIS
  _resetGzipRejectedForTest()
  _resetCacheDiagnosisForTest()
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
})

function sse(messageId: string, text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const ev = (name: string, data: unknown) =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  return new ReadableStream({
    start(c) {
      c.enqueue(
        ev("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
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
          delta: { type: "text_delta", text },
        }),
      )
      c.enqueue(ev("content_block_stop", { type: "content_block_stop", index: 0 }))
      c.enqueue(ev("message_stop", { type: "message_stop" }))
      c.close()
    },
  })
}

type Reply = { status: number; body: string } | undefined

function recorder(script: Reply[] = []): { client: NetworkClient; seen: NetworkRequest[] } {
  const seen: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      seen.push(r)
      const n = seen.length
      const step = script[n - 1]
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
        body: sse(`msg_test_${n}`, `reply ${n}`),
        text: async () => "",
      } as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, seen }
}

function conversation(
  history: CanonicalMessage[] = [],
  modelId = "claude-opus-5-5",
): CanonicalRequest {
  return {
    modelId,
    messages: [...history, { role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [
      { name: "a", description: "", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
    ],
  }
}

async function run(
  req: CanonicalRequest,
  client: NetworkClient,
  auth: ProviderAuth = OAUTH,
): Promise<void> {
  const ctx: RunContext = { auth, sessionId: "s1", networkClient: client }
  for await (const _ of anthropicAdapter.run!(req, resolveModel(req.modelId!), ctx)) {
    // drain
  }
}

const bodyOf = (r: NetworkRequest | undefined): any => JSON.parse(r!.body as string)
const betasOf = (r: NetworkRequest | undefined): string => r!.headers?.["anthropic-beta"] ?? ""

const assistant = (text: string, providerMessageId?: string): CanonicalMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...(providerMessageId !== undefined && { providerMessageId }),
})
const user = (text: string): CanonicalMessage => ({
  role: "user",
  content: [{ type: "text", text }],
})

const err400 = (message: string) => ({
  status: 400,
  body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
})

describe("previous_message_id from providerMessageId (CC Amt/ice)", () => {
  it("the field wins over the fingerprint map", async () => {
    const { client, seen } = recorder()
    await run(conversation(), client) // records "reply 1" → msg_test_1
    await run(conversation([user("go"), assistant("reply 1", "msg_from_field")]), client)
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: "msg_from_field" })
  })

  it("works with no recorder entries (resumed session)", async () => {
    const { client, seen } = recorder()
    await run(conversation([user("old"), assistant("from disk", "msg_resumed")]), client)
    expect(bodyOf(seen[0]).diagnostics).toEqual({ previous_message_id: "msg_resumed" })
  })

  it("falls back to the fingerprint map when the field is missing", async () => {
    const { client, seen } = recorder()
    await run(conversation(), client)
    await run(conversation([user("go"), assistant("reply 1")]), client)
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: "msg_test_1" })
  })

  it("only the LAST assistant message counts", () => {
    const msgs = [user("a"), assistant("x", "msg_old"), user("b"), assistant("never recorded")]
    expect(previousMessageIdFor(msgs)).toBeNull()
  })

  it("a non-msg_ value is ignored (fingerprint fallback, else null)", () => {
    expect(previousMessageIdFor([user("a"), assistant("x", "resp_abc")])).toBeNull()
    expect(previousMessageIdFor([user("a"), assistant("x", "")])).toBeNull()
  })

  it("a rejected id is never re-sent (heal + later re-run of the same history)", async () => {
    const { client, seen } = recorder([
      err400("diagnostics.previous_message_id: message not found"),
    ])
    const history = [user("old"), assistant("from disk", "msg_bad")]
    await run(conversation(history), client)
    expect(bodyOf(seen[0]).diagnostics).toEqual({ previous_message_id: "msg_bad" })
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: null })
    await run(conversation(history), client)
    expect(bodyOf(seen[2]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("forgetMessageId blocks a field id directly", () => {
    const msgs = [user("a"), assistant("x", "msg_zap")]
    expect(previousMessageIdFor(msgs)).toBe("msg_zap")
    forgetMessageId("msg_zap")
    expect(previousMessageIdFor(msgs)).toBeNull()
  })
})

describe("header-only betas (betas-headers.md §1-§4)", () => {
  it("OAuth opus-5-5 conversation carries all four, in CC MAIN order", async () => {
    const { client, seen } = recorder()
    await run(conversation(), client)
    const list = betasOf(seen[0]).split(",")
    const idx = [
      F.PER_TURN_CONTROL,
      F.MID_CONVERSATION_TOOL_CHANGES,
      F.TOOL_PROVENANCE,
      F.THINKING_BINDING_CONTROLS,
    ].map((b) => list.indexOf(b))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    // header only: no block_binding, no message-level output_config.
    const body = bodyOf(seen[0])
    expect(body.thinking?.block_binding).toBeUndefined()
    expect(JSON.stringify(body.messages)).not.toContain("output_config")
  })

  it("thinking-binding-controls follows thinking on the body", async () => {
    const { client, seen } = recorder()
    await run({ ...conversation(), thinking: { mode: "off" } }, client)
    expect(betasOf(seen[0])).not.toContain(F.THINKING_BINDING_CONTROLS)
    expect(bodyOf(seen[0]).thinking).toBeUndefined()
  })

  it("per-turn-control: only CC per_turn_effort models", () => {
    expect([...CC_PER_TURN_EFFORT_MODELS]).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-fable-5-2",
      "claude-mythos-5-2",
    ])
    const expected: Record<string, boolean> = {
      "claude-opus-5-5": true,
      "claude-sonnet-5-5": true,
      "claude-haiku-5-5": true,
      "claude-fable-5-1": true,
      "claude-fable-5-2": true,
      "claude-fable-5": false,
      "claude-opus-5": false,
      "claude-opus-4-8": false,
      "claude-sonnet-5": false,
      "claude-haiku-4-5-20251001": false,
    }
    for (const [id, want] of Object.entries(expected)) {
      expect({ id, on: wantsPerTurnControl(id) }).toEqual({ id, on: want })
    }
  })

  for (const beta of [
    F.PER_TURN_CONTROL,
    F.MID_CONVERSATION_TOOL_CHANGES,
    F.TOOL_PROVENANCE,
    F.THINKING_BINDING_CONTROLS,
  ]) {
    it(`"invalid beta flag" naming ${beta} → dropped for the process, one retry`, async () => {
      const { client, seen } = recorder([err400(`invalid beta flag: ${beta}`)])
      await run(conversation(), client)
      expect(seen.length).toBe(2)
      expect(betasOf(seen[0])).toContain(beta)
      expect(betasOf(seen[1])).not.toContain(beta)
      expect(betasOf(seen[1])).toContain(F.CACHE_DIAGNOSIS)
      await run(conversation(), client)
      expect(seen.length).toBe(3)
      expect(betasOf(seen[2])).not.toContain(beta)
      // The other three stay on.
      expect(betasOf(seen[2])).toContain(
        beta === F.TOOL_PROVENANCE ? F.PER_TURN_CONTROL : F.TOOL_PROVENANCE,
      )
    })
  }

  it("an unrelated invalid beta flag is not healed", async () => {
    const { client, seen } = recorder([err400("invalid beta flag: nope-2026-01-01")])
    await expect(run(conversation(), client)).rejects.toThrow(/Anthropic API 400/)
    expect(seen.length).toBe(1)
  })
})

describe("request-class headers (betas-headers.md §5, CC a1r)", () => {
  const headersFor = (req: CanonicalRequest, auth: ProviderAuth) =>
    buildAnthropicHeaders({
      req,
      model: resolveModel(req.modelId!),
      auth,
      sessionId: "s1",
      clientRequestId: "00000000-0000-0000-0000-000000000000",
    }).headers

  const quota: CanonicalRequest = {
    modelId: "claude-haiku-4-5-20251001",
    messages: [user("quota")],
    generation: { maxOutputTokens: 1 },
  }
  const title: CanonicalRequest = {
    modelId: "claude-haiku-4-5-20251001",
    messages: [user("title me")],
    purpose: "title",
  }
  // Kind "subtask" (≤1 tool, no 1h cache) from the lead is still the lead.
  const smallLead: CanonicalRequest = { ...conversation(), tools: [] }
  const compaction: CanonicalRequest = { ...conversation(), tools: [], purpose: "compaction" }

  const savedSubagentId = process.env.MINIMAL_AGENT_SUBAGENT_ID
  afterEach(() => {
    if (savedSubagentId === undefined) delete process.env.MINIMAL_AGENT_SUBAGENT_ID
    else process.env.MINIMAL_AGENT_SUBAGENT_ID = savedSubagentId
  })

  const cases: ReadonlyArray<[string, CanonicalRequest, string, string]> = [
    ["lead conversation", conversation(), "main", "main"],
    ["lead small request (kind subtask)", smallLead, "main", "main"],
    ["compaction", compaction, "compaction", "summary-extraction"],
    ["title", title, "auxiliary", "summary-extraction"],
    ["quota", quota, "auxiliary", "summary-extraction"],
  ]
  for (const [name, req, code, firstParty] of cases) {
    it(`OAuth ${name} → ${code} / ${firstParty}`, () => {
      delete process.env.MINIMAL_AGENT_SUBAGENT_ID
      const h = headersFor(req, OAUTH)
      expect(h[REQUEST_CLASS_HEADER]).toBe(code)
      expect(h[FIRST_PARTY_REQUEST_CLASS_HEADER]).toBe(firstParty)
    })
  }

  // CC Agent-tool sub-agents: 15/15 subagent / background-task (cc-wire.md).
  const subagentCases: ReadonlyArray<[string, CanonicalRequest, string, string]> = [
    ["main loop (full toolset)", conversation(), "subagent", "background-task"],
    ["small request", smallLead, "subagent", "background-task"],
    ["compaction", compaction, "compaction", "summary-extraction"],
    ["title", title, "auxiliary", "summary-extraction"],
    ["quota", quota, "auxiliary", "summary-extraction"],
  ]
  for (const [name, req, code, firstParty] of subagentCases) {
    it(`sub-agent process: ${name} → ${code} / ${firstParty}`, () => {
      process.env.MINIMAL_AGENT_SUBAGENT_ID = "A7"
      const h = headersFor(req, OAUTH)
      expect(h[REQUEST_CLASS_HEADER]).toBe(code)
      expect(h[FIRST_PARTY_REQUEST_CLASS_HEADER]).toBe(firstParty)
    })
  }

  it("a blank MINIMAL_AGENT_SUBAGENT_ID is not a sub-agent", () => {
    process.env.MINIMAL_AGENT_SUBAGENT_ID = "  "
    expect(headersFor(conversation(), OAUTH)[REQUEST_CLASS_HEADER]).toBe("main")
  })

  it("compaction keeps the kind-based betas (only the header source changes)", () => {
    const betas = (r: CanonicalRequest) =>
      buildAnthropicHeaders({
        req: r,
        model: resolveModel(r.modelId!),
        auth: OAUTH,
        sessionId: "s1",
      }).betaFlags
    expect(betas(compaction)).toEqual(betas(smallLead))
  })

  it("absent with api-key and custom auth", () => {
    for (const auth of [
      { kind: "api-key", key: "sk-test" },
      { kind: "custom", headers: { "x-custom": "1" } },
    ] as ProviderAuth[]) {
      for (const [, req] of cases) {
        const h = headersFor(req, auth)
        expect(h[REQUEST_CLASS_HEADER]).toBeUndefined()
        expect(h[FIRST_PARTY_REQUEST_CLASS_HEADER]).toBeUndefined()
      }
    }
  })

  it("on the wire for an adapter run", async () => {
    delete process.env.MINIMAL_AGENT_SUBAGENT_ID
    const { client, seen } = recorder()
    await run(conversation(), client)
    expect(seen[0]!.headers?.[REQUEST_CLASS_HEADER]).toBe("main")
    expect(seen[0]!.headers?.[FIRST_PARTY_REQUEST_CLASS_HEADER]).toBe("main")
  })
})
