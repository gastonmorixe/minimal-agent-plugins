/**
 * Adapter-level CC 2.1.325 parity: the cache-diagnosis chain (diff A5) and the
 * billing `cc_version` hash derived from the first user prompt (diff A9).
 * No network, no credentials: a fake NetworkClient records each request.
 *
 * Evidence: research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md §1.2, §2.1
 * (D/…fetch-005-02: diagnostics null + cc_version=2.1.325.f16 for "hello 2";
 * D/…fetch-028-02: previous_message_id = previous response's msg_ id).
 *
 * @module llm/providers/anthropic/adapter.cache-diagnosis.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { pluginSideband } from "../tests/support/sideband.ts"

import {
  _resetCacheDiagnosisForTest,
  _resetGzipRejectedForTest,
  anthropicAdapter,
  bootstrapAnthropic,
  firstUserPromptText,
  markedWireBlocks,
} from "./adapter.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { buildBillingHeaderText } from "./system-prompt.ts"
import { useTempAgentHome } from "./test-home.ts"
import { BUILD_HASH, VERSION } from "./wire-constants.ts"

useTempAgentHome()

const OAUTH: ProviderAuth = { kind: "oauth", token: "sk-ant-oat01-test" }
const CACHE_DIAGNOSIS = "cache-diagnosis-2026-04-07"

let resolveModel: (id: string) => ModelEntry

beforeEach(() => {
  // Keep bodies readable (no gzip) and the env opt-outs off.
  process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = "1"
  delete process.env.MINIMAL_AGENT_NO_CACHE_DIAGNOSIS
  _resetGzipRejectedForTest()
  _resetCacheDiagnosisForTest()
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
})

/** Text the fake server answers with for request number `n`. */
const replyText = (n: number) => `reply ${n}`

/**
 * SSE stream: message_start(id), one text block, then message_stop. With
 * `failMidStream` it emits an `error` event and stops (no message_stop).
 */
function sse(messageId: string, text: string, failMidStream = false): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const start = {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }
  const ev = (name: string, data: unknown) =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  return new ReadableStream({
    start(c) {
      c.enqueue(ev("message_start", start))
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
      if (failMidStream) {
        c.enqueue(ev("error", { type: "error", error: { type: "overloaded_error", message: "x" } }))
        c.close()
        return
      }
      c.enqueue(ev("content_block_stop", { type: "content_block_stop", index: 0 }))
      c.enqueue(ev("message_stop", { type: "message_stop" }))
      c.close()
    },
  })
}

type Reply = { status: number; body: string } | "fail-mid-stream" | undefined

/**
 * Fake client: request n (1-based) answers `msg_test_n` / "reply n", unless
 * `script[n-1]` says to fail it (an HTTP error body or a mid-stream error).
 */
function recorder(script: Reply[] = []): { client: NetworkClient; seen: NetworkRequest[] } {
  const seen: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      seen.push(r)
      const n = seen.length
      const step = script[n - 1]
      if (step && step !== "fail-mid-stream") {
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
        body: sse(`msg_test_${n}`, replyText(n), step === "fail-mid-stream"),
        text: async () => "",
      } as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, seen }
}

/** Conversation-shaped request (2 tools → kind "conversation"). */
function conversation(text = "hi", history: CanonicalMessage[] = []): CanonicalRequest {
  return {
    modelId: "claude-opus-4-8",
    system: [
      { type: "text", text: buildBillingHeaderText() },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
    messages: [...history, { role: "user", content: [{ type: "text", text }] }],
    tools: [
      { name: "a", description: "", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
    ],
  }
}

async function run(
  req: CanonicalRequest,
  client: NetworkClient,
  sessionId = "s1",
  auth: ProviderAuth = OAUTH,
): Promise<void> {
  const ctx: RunContext = { auth, sessionId, networkClient: client }
  for await (const _ of anthropicAdapter.run!(req, resolveModel("claude-opus-4-8"), ctx)) {
    // drain
  }
}

const bodyOf = (r: NetworkRequest | undefined): any => JSON.parse(r!.body as string)

const assistant = (text: string): CanonicalMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** History of one finished turn: the user prompt + the fake server's reply n. */
const turn = (prompt: string, n: number): CanonicalMessage[] => [
  { role: "user", content: [{ type: "text", text: prompt }] },
  assistant(replyText(n)),
]

describe("cache-diagnosis chain (diff A5)", () => {
  it("first request: beta header on, diagnostics.previous_message_id null", async () => {
    const { client, seen } = recorder()
    await run(conversation(), client)
    expect(seen[0]!.headers?.["anthropic-beta"]).toContain(CACHE_DIAGNOSIS)
    expect(bodyOf(seen[0]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("next turn carries the msg id of the last assistant message in the history", async () => {
    const { client, seen } = recorder()
    await run(conversation("hi"), client)
    await run(conversation("next", turn("hi", 1)), client)
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: "msg_test_1" })
  })

  it("an assistant message the plugin never produced resolves to null", async () => {
    const { client, seen } = recorder()
    await run(conversation("next", [...turn("hi", 0), assistant("from elsewhere")]), client)
    expect(bodyOf(seen[0]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("a different session starts its own chain at null", async () => {
    const { client, seen } = recorder()
    await run(conversation(), client, "s1")
    await run(conversation(), client, "s2")
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("quota probes carry neither the beta nor the body field", async () => {
    const { client, seen } = recorder()
    const quota: CanonicalRequest = {
      modelId: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: [{ type: "text", text: "quota" }] }],
      generation: { maxOutputTokens: 1 },
    }
    await run(quota, client)
    expect(seen[0]!.headers?.["anthropic-beta"]).not.toContain(CACHE_DIAGNOSIS)
    expect(bodyOf(seen[0]).diagnostics).toBeUndefined()
  })

  it("api-key auth does not enable it by default", async () => {
    const { client, seen } = recorder()
    await run(conversation(), client, "s1", { kind: "api-key", key: "sk-test" })
    expect(seen[0]!.headers?.["anthropic-beta"] ?? "").not.toContain(CACHE_DIAGNOSIS)
    expect(bodyOf(seen[0]).diagnostics).toBeUndefined()
  })

  it("honors MINIMAL_AGENT_NO_CACHE_DIAGNOSIS=1", async () => {
    process.env.MINIMAL_AGENT_NO_CACHE_DIAGNOSIS = "1"
    try {
      const { client, seen } = recorder()
      await run(conversation(), client)
      expect(seen[0]!.headers?.["anthropic-beta"]).not.toContain(CACHE_DIAGNOSIS)
      expect(bodyOf(seen[0]).diagnostics).toBeUndefined()
    } finally {
      delete process.env.MINIMAL_AGENT_NO_CACHE_DIAGNOSIS
    }
  })
})

describe("billing cc_version hash from the first user prompt (diff A9)", () => {
  it("skips leading sideband blocks and hashes the prompt (CC meta-message skip)", async () => {
    const { client, seen } = recorder()
    const req = conversation()
    req.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "<ma::agent::policy>Current local time: …</ma::agent::policy>" },
          { type: "text", text: "hello 2" },
        ],
      },
    ]
    await run(req, client)
    const sys0 = bodyOf(seen[0]).system[0].text as string
    // Real CC capture: prompt "hello 2" → cc_version=2.1.325.f16 (D/…fetch-005-02).
    expect(sys0).toContain(`cc_version=${VERSION}.f16;`)
    expect(VERSION).toBe("2.1.325")
  })

  it("skips a marked first block that is not a tag (block mark decides, design step 12)", async () => {
    const { client, seen } = recorder()
    const req = conversation()
    req.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "notice text with no tag", sideband: { kind: "policy" } },
          { type: "text", text: "hello 2" },
        ],
      },
    ]
    await run(req, client)
    expect(bodyOf(seen[0]).system[0].text as string).toContain(`cc_version=${VERSION}.f16;`)
    // The mark is metadata only: it never reaches the wire.
    expect(JSON.stringify(bodyOf(seen[0]).messages)).not.toContain('"sideband"')
  })

  it("old history: a first block that starts with a tag and has no mark stays meta", async () => {
    // Documented result: an unmarked block (a session log from before the
    // mark, or a block that core does not mark yet) uses the text fallback.
    // The hash is the same as before step 12: the tag block is skipped and
    // the next text block ("hello 2") gives the hash.
    const sb = await pluginSideband()
    const tag = sb.render("policy", { body: "Current local time: x" })
    expect(tag.length).toBeGreaterThan(0)
    const { client, seen } = recorder()
    const req = conversation()
    req.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: tag },
          { type: "text", text: "hello 2" },
        ],
      },
    ]
    await run(req, client)
    expect(bodyOf(seen[0]).system[0].text as string).toContain(`cc_version=${VERSION}.f16;`)
    const wire = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: tag },
          { type: "text" as const, text: "hello 2" },
        ],
      },
    ]
    expect(firstUserPromptText(wire)).toBe("hello 2")
    expect(firstUserPromptText(wire, new Set())).toBe("hello 2")
  })

  it("markedWireBlocks maps the canonical marks to the wire blocks", () => {
    const wireA = { type: "text" as const, text: "a" }
    const wireB = { type: "text" as const, text: "b" }
    const canon = (marks: boolean[]) => ({
      messages: [
        {
          role: "user" as const,
          content: marks.map((m, i) => ({
            type: "text" as const,
            text: String(i),
            ...(m ? { sideband: { kind: "policy" } } : {}),
          })),
        },
      ],
    })
    const body = { messages: [{ role: "user" as const, content: [wireA, wireB] }] }
    const marked = markedWireBlocks(canon([true, false]), body)
    expect(marked.has(wireA)).toBe(true)
    expect(marked.has(wireB)).toBe(false)
    expect(firstUserPromptText(body.messages, marked)).toBe("b")
    // A block count that changed on the way gives no mark (text fallback).
    expect(markedWireBlocks(canon([true]), body).size).toBe(0)
  })

  it("leaves the billing header alone for api-key auth", async () => {
    const { client, seen } = recorder()
    await run(conversation("hello 2"), client, "s1", { kind: "api-key", key: "sk-test" })
    expect(bodyOf(seen[0]).system[0].text).toContain(`cc_version=${VERSION}.${BUILD_HASH};`)
  })

  it("firstUserPromptText handles string content and missing user messages", () => {
    expect(firstUserPromptText([{ role: "user", content: "hello 2" }])).toBe("hello 2")
    expect(firstUserPromptText([{ role: "assistant", content: "x" }])).toBe("")
    expect(
      firstUserPromptText([
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
        { role: "user", content: "later" },
      ]),
    ).toBe("a") // CC j(): FIRST text block of the first non-meta user message
  })
})

describe("cache-diagnosis chain: failure, interleaving, side calls (review MINOR-4)", () => {
  it("a mid-stream error is never recorded; the next request sends null", async () => {
    const { client, seen } = recorder(["fail-mid-stream"])
    await run(conversation("hi"), client)
    await run(conversation("next", turn("hi", 1)), client)
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("an aborted stream (consumer stops before message_stop) is never recorded", async () => {
    const { client, seen } = recorder()
    const ctx: RunContext = { auth: OAUTH, sessionId: "s1", networkClient: client }
    for await (const ev of anthropicAdapter.run!(
      conversation("hi"),
      resolveModel("claude-opus-4-8"),
      ctx,
    )) {
      if (ev.type === "text_delta") break
    }
    await run(conversation("next", turn("hi", 1)), client)
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("two interleaved requests each chain to their own response", async () => {
    const { client, seen } = recorder()
    const model = resolveModel("claude-opus-4-8")
    const ctx: RunContext = { auth: OAUTH, sessionId: "s1", networkClient: client }
    const a = anthropicAdapter.run!(conversation("A"), model, ctx)[Symbol.asyncIterator]()
    const b = anthropicAdapter.run!(conversation("B"), model, ctx)[Symbol.asyncIterator]()
    // Step both streams alternately until done.
    let doneA = false
    let doneB = false
    while (!doneA || !doneB) {
      if (!doneA) doneA = !!(await a.next()).done
      if (!doneB) doneB = !!(await b.next()).done
    }
    // A was sent first → msg_test_1 / "reply 1"; B → msg_test_2 / "reply 2".
    await run(conversation("next", turn("B", 2)), client)
    await run(conversation("next", turn("A", 1)), client)
    expect(bodyOf(seen[2]).diagnostics).toEqual({ previous_message_id: "msg_test_2" })
    expect(bodyOf(seen[3]).diagnostics).toEqual({ previous_message_id: "msg_test_1" })
  })

  it("a side call does not pollute the main chain", async () => {
    const { client, seen } = recorder()
    await run(conversation("main"), client) // msg_test_1
    await run(conversation("side question"), client) // msg_test_2 (side call)
    await run(conversation("main 2", turn("main", 1)), client)
    expect(bodyOf(seen[2]).diagnostics).toEqual({ previous_message_id: "msg_test_1" })
  })

  it("omits body.diagnostics when betaOverrides.remove drops the beta", async () => {
    const { client, seen } = recorder()
    const req = conversation()
    req.vendor = { anthropic: { betaOverrides: { remove: [CACHE_DIAGNOSIS] } } }
    await run(req, client)
    expect(seen[0]!.headers?.["anthropic-beta"]).not.toContain(CACHE_DIAGNOSIS)
    expect(bodyOf(seen[0]).diagnostics).toBeUndefined()
  })
})

const err400 = (message: string) => ({
  status: 400,
  body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
})

describe("400 heals (review MAJOR-2 / MAJOR-3)", () => {
  it("previous_message_id rejected → one retry with previous_message_id:null", async () => {
    const { client, seen } = recorder([
      undefined,
      err400("diagnostics.previous_message_id: message not found"),
    ])
    await run(conversation("hi"), client)
    await run(conversation("next", turn("hi", 1)), client)
    expect(seen.length).toBe(3)
    expect(bodyOf(seen[1]).diagnostics).toEqual({ previous_message_id: "msg_test_1" })
    expect(bodyOf(seen[2]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("rejected thinking-token-count beta → dropped and retried once, then stays off", async () => {
    const TTC = "thinking-token-count-2026-05-13"
    const { client, seen } = recorder([err400(`invalid beta flag: ${TTC}`)])
    await run(conversation(), client)
    expect(seen.length).toBe(2)
    expect(seen[0]!.headers?.["anthropic-beta"]).toContain(TTC)
    expect(seen[1]!.headers?.["anthropic-beta"]).not.toContain(TTC)
    expect(seen[1]!.headers?.["anthropic-beta"]).toContain(CACHE_DIAGNOSIS)
    await run(conversation(), client)
    expect(seen[2]!.headers?.["anthropic-beta"]).not.toContain(TTC)
  })

  it("after the previous_message_id heal, the same history resolves to null (W3)", async () => {
    const { client, seen } = recorder([
      undefined,
      err400("diagnostics.previous_message_id: message not found"),
    ])
    await run(conversation("hi"), client)
    await run(conversation("next", turn("hi", 1)), client)
    // A later re-run of the same request (e.g. withRetry) must not resend it.
    await run(conversation("next", turn("hi", 1)), client)
    expect(seen.length).toBe(4)
    expect(bodyOf(seen[3]).diagnostics).toEqual({ previous_message_id: null })
  })

  it("invalid beta flag naming another beta does not latch the TTC drop (S3)", async () => {
    const TTC = "thinking-token-count-2026-05-13"
    const { client, seen } = recorder([err400("invalid beta flag: some-other-beta-2026-01-01")])
    await expect(run(conversation(), client)).rejects.toThrow(/Anthropic API 400/)
    expect(seen.length).toBe(1)
    expect(seen[0]!.headers?.["anthropic-beta"]).toContain(TTC)
    await run(conversation(), client)
    expect(seen[1]!.headers?.["anthropic-beta"]).toContain(TTC)
  })

  it("an unrelated 400 is surfaced without a retry", async () => {
    const { client, seen } = recorder([err400("messages: field required")])
    await expect(run(conversation(), client)).rejects.toThrow(/Anthropic API 400/)
    expect(seen.length).toBe(1)
  })
})

describe("firstUserPromptText mirrors CC j() (review MINOR-2)", () => {
  const img = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "AA==" },
  }

  it("image-only first prompt hashes the empty string", () => {
    expect(firstUserPromptText([{ role: "user", content: [img] } as never])).toBe("")
  })

  it("a prompt followed by an attachment text block hashes the prompt", () => {
    expect(
      firstUserPromptText([
        {
          role: "user",
          content: [
            { type: "text", text: "<ma::agent::policy>…</ma::agent::policy>" },
            { type: "text", text: "summarize this" },
            { type: "text", text: "<file path='a.ts'>…</file>" },
          ],
        },
      ]),
    ).toBe("summarize this")
  })

  it("skips a first user message made only of meta blocks", () => {
    expect(
      firstUserPromptText([
        { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "real prompt" },
      ]),
    ).toBe("real prompt")
  })
})
