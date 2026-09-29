/**
 * After a tool result is written on the open Run stream, a server that goes
 * silent (only heartbeats, no content) cost 120 s: the host watchdog stays in
 * "pre-headers" because a continuation makes no new HTTP request, so its
 * response hooks never fire. 144 of 183 tool-result gaps in session d79d1732
 * (2026-09-25) took 100-140 s, then a fresh Run answered in 0.17 s.
 *
 * The bidi read loop must give up on its own after MA_CURSOR_BIDI_CONTINUE_IDLE_MS
 * without progress and throw a retryable error, so the host retries at once.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { runCursorBidi } from "./bidi-run.ts"
import { connectFrameProto } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
import { concat, encMsg, encString, encVarintField } from "./proto/wire.ts"

function mcpExecFrame(opts: { id: number; toolCallId: string; toolName: string }): Uint8Array {
  const mcpArgs = concat(
    encString(3, opts.toolCallId),
    encString(4, "minimal-agent"),
    encString(5, opts.toolName),
  )
  const exec = concat(encVarintField(1, opts.id), encMsg(11, mcpArgs))
  return connectFrameProto(encMsg(2, exec))
}

/** InteractionUpdate.heartbeat (#13) inside AgentServerMessage.interaction_update (#1). */
function heartbeatFrame(): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(13, new Uint8Array(0))))
}

function textFrame(text: string): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(1, encString(1, text))))
}

function turnEndedFrame(): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0))))
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
  return { request: async () => response }
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
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  vendorIds: { cursor: "default" },
}

const continuation: CanonicalRequest = {
  ...req,
  messages: [
    ...req.messages,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "ModelInfo", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call_1", content: [{ type: "text", text: "ok" }] },
      ],
    },
  ],
}

function runOpts(sessionId: string, client: NetworkClient) {
  return {
    url: "https://example.test/agent.v1.AgentService/Run",
    headers: {},
    initialRunBody: new Uint8Array([0]),
    sessionId,
    modelId: "cursor-auto",
    networkClient: client,
  }
}

/** Run turn 1 up to the tool_use pause, and return the controller for the open wire. */
async function firstTurnToPause(sessionId: string, client: NetworkClient): Promise<string[]> {
  const events: string[] = []
  for await (const ev of runCursorBidi(req, model as never, runOpts(sessionId, client))) {
    events.push(ev.type)
  }
  return events
}

describe("cursor bidi continuation idle guard", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    delete process.env.MA_CURSOR_BIDI_CONTINUE_IDLE_MS
    resetCursorBidiSessionsForTests()
  })

  test("heartbeats only after the tool result: throws a retryable timeout, does not hang", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    process.env.MA_CURSOR_BIDI_CONTINUE_IDLE_MS = "150"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(mcpExecFrame({ id: 5, toolCallId: "call_1", toolName: "ModelInfo" }))
      },
    })
    let wroteResult = false
    const client = fakeClient(stream, () => {
      wroteResult = true
    })
    const first = await firstTurnToPause("idle-hb", client)
    expect(first).toContain("message_stop")

    // Server keeps the wire alive with heartbeats but never answers the result.
    const beat = setInterval(() => ctrl?.enqueue(heartbeatFrame()), 20)
    try {
      const started = Date.now()
      const events: { type: string; retryable?: boolean; category?: string }[] = []
      let thrown: unknown
      const run = (async () => {
        try {
          for await (const ev of runCursorBidi(
            continuation,
            model as never,
            runOpts("idle-hb", client),
          )) {
            events.push(ev as never)
          }
        } catch (err) {
          thrown = err
        }
      })()
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("continuation hung: no idle guard")), 3000),
      )
      await Promise.race([run, timeout])

      expect(wroteResult).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      const errEvent = events.find((e) => e.type === "stream_error")
      // Either surfaced as a stream_error event or as a thrown error, both retryable.
      if (errEvent) {
        expect(errEvent.retryable).toBe(true)
        expect(errEvent.category).toBe("timeout")
        // core retry.ts only retries known tags. "stream_idle" is one of them.
        expect(errEvent.upstreamType).toBe("stream_idle")
      } else {
        expect(String(thrown)).toContain("no progress")
      }
    } finally {
      clearInterval(beat)
    }
  })

  test("real frames after the tool result keep the guard quiet", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    process.env.MA_CURSOR_BIDI_CONTINUE_IDLE_MS = "150"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(mcpExecFrame({ id: 5, toolCallId: "call_1", toolName: "ModelInfo" }))
      },
    })
    const client = fakeClient(stream, () => {})
    await firstTurnToPause("idle-ok", client)

    // Content trickles in slower than heartbeats but faster than the guard.
    setTimeout(() => ctrl?.enqueue(textFrame("da")), 60)
    setTimeout(() => ctrl?.enqueue(textFrame("ta")), 120)
    setTimeout(() => {
      ctrl?.enqueue(turnEndedFrame())
      ctrl?.close()
    }, 180)

    let text = ""
    const types: string[] = []
    for await (const ev of runCursorBidi(
      continuation,
      model as never,
      runOpts("idle-ok", client),
    )) {
      types.push(ev.type)
      if (ev.type === "text_delta") text += ev.text
    }
    expect(text).toBe("data")
    expect(types).not.toContain("stream_error")
    expect(types.at(-1)).toBe("message_stop")
  })

  test("guard off (0) never fires", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    process.env.MA_CURSOR_BIDI_CONTINUE_IDLE_MS = "0"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(mcpExecFrame({ id: 5, toolCallId: "call_1", toolName: "ModelInfo" }))
      },
    })
    const client = fakeClient(stream, () => {})
    await firstTurnToPause("idle-off", client)
    setTimeout(() => {
      ctrl?.enqueue(textFrame("late"))
      ctrl?.enqueue(turnEndedFrame())
      ctrl?.close()
    }, 300)
    let text = ""
    for await (const ev of runCursorBidi(
      continuation,
      model as never,
      runOpts("idle-off", client),
    )) {
      if (ev.type === "text_delta") text += ev.text
    }
    expect(text).toBe("late")
  })
})
