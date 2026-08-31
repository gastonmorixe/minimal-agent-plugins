/**
 * Offline: text-only bidi turns stall unless KvServerMessage get/set is answered.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { runCursorBidi } from "./bidi-run.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
import { concat, decodeFields, encBytes, encMsg, encString, encVarintField } from "./proto/wire.ts"

function textFrame(text: string): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(1, encString(1, text))))
}

function turnEndedFrame(): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0))))
}

function kvSetFrame(id: number, blobId: Uint8Array, blobData: Uint8Array): Uint8Array {
  return connectFrameProto(
    encMsg(
      4,
      concat(encVarintField(1, id), encMsg(3, concat(encBytes(1, blobId), encBytes(2, blobData)))),
    ),
  )
}

function isKvClientWrite(chunk: Uint8Array): boolean {
  return parseConnectFrames(chunk).some((frame) =>
    decodeFields(frame.payload).some((field) => field.no === 3),
  )
}

function fakeClient(
  body: ReadableStream<Uint8Array>,
  writeRequestBody: (chunk: Uint8Array) => void,
): NetworkClient {
  const response: NetworkResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/connect+proto" }),
    body,
    transport: { id: "test", protocol: "h2" },
    ok: true,
    text: async () => "",
    json: async <T>() => ({}) as T,
    writeRequestBody,
    endRequestBody() {},
  }
  return {
    request: async () => response,
  }
}

const req: CanonicalRequest = {
  modelId: "cursor-auto",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [
    { name: "ModelInfo", description: "meta", inputSchema: { type: "object", properties: {} } },
  ],
}

const model = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: "agent-run",
  displayName: "Auto",
  capabilities: {
    tools: { userDefined: true },
    streaming: true,
    thinking: false,
    vision: false,
    maxOutputTokens: 64,
  },
  pricing: {
    inputUSD: 0,
    outputUSD: 0,
    cacheWriteUSD: 0,
    cacheReadUSD: 0,
    webSearchPerCallUSD: 0,
  },
  vendorIds: { cursor: "default" },
}

describe("cursor bidi KV acks", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorBidiSessionsForTests()
  })

  test("answers set_blob and then receives turn_ended", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    let acked = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(textFrame("PONG"))
        controller.enqueue(kvSetFrame(4, new Uint8Array([1]), new Uint8Array([2, 3])))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      if (!isKvClientWrite(chunk) || acked || !bodyController) return
      acked = true
      bodyController.enqueue(turnEndedFrame())
      bodyController.close()
    })

    const events: string[] = []
    let text = ""
    for await (const ev of runCursorBidi(req, model as never, {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      sessionId: "kv-ack",
      modelId: "cursor-auto",
      networkClient: client,
    })) {
      events.push(ev.type)
      if (ev.type === "text_delta") text += ev.text
    }

    expect(acked).toBe(true)
    expect(text).toBe("PONG")
    expect(events).toContain("message_start")
    expect(events).toContain("message_stop")
  })
})

function mcpExecFrame(opts: { id: number; toolCallId: string; toolName: string }): Uint8Array {
  const mcpArgs = concat(
    encString(3, opts.toolCallId),
    encString(4, "minimal-agent"),
    encString(5, opts.toolName),
  )
  const exec = concat(encVarintField(1, opts.id), encMsg(11, mcpArgs))
  return connectFrameProto(encMsg(2, exec))
}

function isConversationActionWrite(chunk: Uint8Array): boolean {
  return parseConnectFrames(chunk).some((frame) =>
    decodeFields(frame.payload).some((field) => field.no === 4),
  )
}

describe("BUG-293802 cursor bidi queued follow-up", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorBidiSessionsForTests()
  })

  test("writes conversation_action when tool continuation carries queued user text", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const writes: Uint8Array[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(mcpExecFrame({ id: 9, toolCallId: "call_1", toolName: "WebSearch" }))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      writes.push(chunk)
      if (!isConversationActionWrite(chunk) || !bodyController) return
      bodyController.enqueue(turnEndedFrame())
      bodyController.close()
    })

    const first = runCursorBidi(req, model as never, {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      sessionId: "queued-follow-up",
      modelId: "cursor-auto",
      networkClient: client,
    })
    const firstEvents: string[] = []
    for await (const ev of first) firstEvents.push(ev.type)
    expect(firstEvents).toContain("message_stop")

    const continuation: CanonicalRequest = {
      ...req,
      messages: [
        ...req.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "WebSearch", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_1",
              content: [{ type: "text", text: "search hits" }],
            },
            { type: "text", text: "what is the square root of 9?" },
          ],
        },
      ],
    }
    const secondEvents: string[] = []
    for await (const ev of runCursorBidi(continuation, model as never, {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      sessionId: "queued-follow-up",
      modelId: "cursor-auto",
      networkClient: client,
    })) {
      secondEvents.push(ev.type)
    }

    expect(writes.some(isConversationActionWrite)).toBe(true)
    expect(secondEvents).toContain("message_stop")

    const fieldOrder = writes.flatMap((chunk) =>
      parseConnectFrames(chunk).flatMap((frame) => decodeFields(frame.payload).map((f) => f.no)),
    )
    const actionAt = fieldOrder.indexOf(4)
    const execAt = fieldOrder.indexOf(2)
    const closeAt = fieldOrder.indexOf(5)
    expect(actionAt).toBeGreaterThanOrEqual(0)
    expect(execAt).toBeGreaterThan(actionAt)
    expect(closeAt).toBeGreaterThan(execAt)
  })

  test("does not write conversation_action for tool_results-only continuation", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const writes: Uint8Array[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(mcpExecFrame({ id: 9, toolCallId: "call_1", toolName: "WebSearch" }))
      },
    })
    let closed = false
    const client = fakeClient(stream, (chunk) => {
      writes.push(chunk)
      if (closed || !bodyController) return
      const isExecResult = parseConnectFrames(chunk).some((frame) =>
        decodeFields(frame.payload).some((field) => field.no === 2),
      )
      if (!isExecResult) return
      closed = true
      bodyController.enqueue(turnEndedFrame())
      bodyController.close()
    })

    for await (const _ev of runCursorBidi(req, model as never, {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      sessionId: "no-follow-up",
      modelId: "cursor-auto",
      networkClient: client,
    })) {
      /* drain first pause */
    }

    const continuation: CanonicalRequest = {
      ...req,
      messages: [
        ...req.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "WebSearch", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_1",
              content: [{ type: "text", text: "search hits" }],
            },
          ],
        },
      ],
    }
    for await (const _ev of runCursorBidi(continuation, model as never, {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      sessionId: "no-follow-up",
      modelId: "cursor-auto",
      networkClient: client,
    })) {
      /* drain */
    }

    expect(writes.some(isConversationActionWrite)).toBe(false)
  })

  /**
   * Heather (3c7e375a): continue reuses envelopeGen bound to attempt-1's AbortSignal.
   * Watchdog aborts attempt-2's signal; the hung read never sees it → "Sending request" forever.
   */
  test("continue read aborts when the NEW attempt signal fires (not the open-time signal)", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const openSignal = new AbortController()
    const continueSignal = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(mcpExecFrame({ id: 9, toolCallId: "call_1", toolName: "WebSearch" }))
        // Intentionally never enqueue turn_ended after mcp reply — silent hang.
      },
    })
    const client = fakeClient(stream, () => {
      /* mcp_result / stream_close writes; server stays silent */
    })

    for await (const _ev of runCursorBidi(req, model as never, {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      signal: openSignal.signal,
      sessionId: "abort-rebinding",
      modelId: "cursor-auto",
      networkClient: client,
    })) {
      /* drain first pause */
    }

    const continuation: CanonicalRequest = {
      ...req,
      messages: [
        ...req.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "WebSearch", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_1",
              content: [{ type: "text", text: "search hits" }],
            },
          ],
        },
      ],
    }

    const continueDone = (async () => {
      for await (const _ev of runCursorBidi(continuation, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        signal: continueSignal.signal,
        sessionId: "abort-rebinding",
        modelId: "cursor-auto",
        networkClient: client,
      })) {
        /* drain until abort unblocks */
      }
    })()

    await Bun.sleep(40)
    continueSignal.abort()

    const hung = Bun.sleep(500).then(() => {
      throw new Error(
        "hung: continue ignored attempt-2 AbortSignal (envelopeGen still bound to open-time signal)",
      )
    })
    await Promise.race([continueDone, hung])
  })
})
