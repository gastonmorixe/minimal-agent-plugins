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
