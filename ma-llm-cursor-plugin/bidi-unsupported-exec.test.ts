/**
 * Offline: an ExecServerMessage that MA cannot answer must get the same reply
 * the official CLI sends when it has no handler:
 * `exec_client_control_message { throw { id, error } }`, then
 * `{ stream_close { id } }` (index.js, CLI 2026.09.28-64d2043).
 * Before this fix the frame was dropped, the server waited forever, and
 * heartbeats kept the stream open, so the turn hung.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { runCursorBidi } from "./bidi-run.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
import { findUnsupportedExec } from "./proto/exec-server-decode.ts"
import {
  concat,
  encMsg,
  encString,
  encVarintField,
  getFirstMsg,
  getFirstString,
  getFirstVarint,
} from "./proto/wire.ts"

function execFrameBody(fieldNo: number, args: Uint8Array): Uint8Array {
  return concat(encVarintField(1, 3), encMsg(19, encString(1, "span")), encMsg(fieldNo, args))
}

function serverExec(fieldNo: number, args: Uint8Array = new Uint8Array(0)): Uint8Array {
  return encMsg(2, execFrameBody(fieldNo, args))
}

describe("findUnsupportedExec", () => {
  test("names request_context_args (#10), which MA cannot answer", () => {
    expect(findUnsupportedExec(serverExec(10))).toEqual({
      fieldNo: 10,
      name: "request_context_args",
    })
  })

  test("names a shell exec with an empty command (dropped by the native mapper)", () => {
    expect(findUnsupportedExec(serverExec(2, encString(1, "")))).toEqual({
      fieldNo: 2,
      name: "shell_args",
    })
  })

  test("ignores exec kinds MA answers: mcp_args, mcp_state, mapped natives", () => {
    const mcpArgs = concat(encString(3, "call-1"), encString(4, "minimal-agent"), encString(5, "X"))
    expect(findUnsupportedExec(serverExec(11, mcpArgs))).toBeUndefined()
    expect(findUnsupportedExec(serverExec(36, encString(1, "minimal-agent")))).toBeUndefined()
    expect(findUnsupportedExec(serverExec(5, encString(1, "needle")))).toBeUndefined()
  })

  test("ignores frames that are not exec requests", () => {
    expect(findUnsupportedExec(encMsg(1, encMsg(1, encString(1, "hi"))))).toBeUndefined()
    // exec_server_message with only span_context: no args oneof set.
    expect(findUnsupportedExec(encMsg(2, encMsg(19, encString(1, "s"))))).toBeUndefined()
  })
})

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

/** AgentClientMessage.exec_client_control_message (#5) bodies in one write. */
function controlWrites(chunk: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const frame of parseConnectFrames(chunk)) {
    const ctrl = getFirstMsg(frame.payload, 5)
    if (ctrl) out.push(ctrl)
  }
  return out
}

function textFrame(text: string): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(1, encString(1, text))))
}

function turnEndedFrame(): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0))))
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

describe("cursor bidi unsupported exec", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorBidiSessionsForTests()
  })

  test("answers throw + stream_close like the official CLI, then the turn continues", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const controls: Uint8Array[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(connectFrameProto(serverExec(10)))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      controls.push(...controlWrites(chunk))
      // The server goes on only after the throw AND the stream_close arrive.
      if (controls.length === 2 && ctrl) {
        ctrl.enqueue(textFrame("AFTER"))
        ctrl.enqueue(turnEndedFrame())
        ctrl.close()
        ctrl = undefined
      }
    })
    const events: CanonicalEvent[] = []
    let text = ""
    const run = (async () => {
      for await (const ev of runCursorBidi(req, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        sessionId: "unsupported-exec",
        modelId: "cursor-auto",
        networkClient: client,
      })) {
        events.push(ev)
        if (ev.type === "text_delta") text += ev.text
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("hung: unsupported exec never answered")), 2000),
    )
    await Promise.race([run, timeout])

    expect(controls).toHaveLength(2)
    // 1: ExecClientControlMessage.throw (#2) = ExecClientThrow { 1 id, 2 error }
    const thrown = getFirstMsg(controls[0]!, 2)
    expect(thrown).toBeDefined()
    expect(getFirstVarint(thrown!, 1)).toBe(3)
    expect(getFirstString(thrown!, 2)).toContain("request_context_args")
    // 2: ExecClientControlMessage.stream_close (#1) = ExecClientStreamClose { 1 id }
    const closed = getFirstMsg(controls[1]!, 1)
    expect(closed).toBeDefined()
    expect(getFirstVarint(closed!, 1)).toBe(3)
    expect(text).toBe("AFTER")
    expect(events.some((e) => e.type === "stream_error")).toBe(false)
  })
})
