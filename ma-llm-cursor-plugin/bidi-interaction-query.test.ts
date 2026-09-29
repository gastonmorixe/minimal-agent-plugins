/**
 * Offline: Cursor sends AgentServerMessage.interaction_query (#7) and waits for
 * AgentClientMessage.interaction_response (#6). MA has no approval UI, so it
 * must reject at once. Unanswered, the turn hangs (audit rank 5, 2026-09-28).
 */

import { afterEach, describe, expect, test } from "bun:test"

import { runCursorBidi } from "./bidi-run.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
import {
  decodeFields,
  encMsg,
  encString,
  encVarintField,
  fieldBytes,
  fieldString,
  fieldVarint,
} from "./proto/wire.ts"

/** Payloads of every AgentClientMessage.interaction_response (#6) in one write. */
function interactionResponses(chunk: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const frame of parseConnectFrames(chunk)) {
    for (const f of decodeFields(frame.payload)) {
      if (f.no === 6 && f.wire === 2) {
        const b = fieldBytes(f)
        if (b) out.push(b)
      }
    }
  }
  return out
}

function queryFrame(id: number, queryField: number): Uint8Array {
  const inner = new Uint8Array([...encVarintField(1, id), ...encMsg(queryField, new Uint8Array(0))])
  return connectFrameProto(encMsg(7, inner))
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

describe("cursor bidi interaction_query", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorBidiSessionsForTests()
  })

  test("rejects a web_search query, then the turn continues and ends", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const replies: Uint8Array[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(queryFrame(11, 2))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      for (const r of interactionResponses(chunk)) {
        replies.push(r)
        // Server only continues once the client answered the query.
        if (replies.length === 1 && ctrl) {
          ctrl.enqueue(textFrame("AFTER"))
          ctrl.enqueue(turnEndedFrame())
          ctrl.close()
        }
      }
    })

    let text = ""
    const run = (async () => {
      for await (const ev of runCursorBidi(req, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        sessionId: "interaction-query",
        modelId: "cursor-auto",
        networkClient: client,
      })) {
        if (ev.type === "text_delta") text += ev.text
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("turn hung: interaction_query was not answered")), 2000),
    )
    await Promise.race([run, timeout])

    expect(text).toBe("AFTER")
    expect(replies).toHaveLength(1)
    const fields = decodeFields(replies[0]!)
    expect(fieldVarint(fields.find((f) => f.no === 1)!)).toBe(11)
    const result = decodeFields(fieldBytes(fields.find((f) => f.no === 2)!)!)
    const rejected = decodeFields(fieldBytes(result.find((f) => f.no === 2)!)!)
    expect(fieldString(rejected.find((f) => f.no === 1)!)).toContain("cannot approve")
  })

  test("answers every query in a burst, ids echoed in order", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const ids: number[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(queryFrame(1, 4))
        controller.enqueue(queryFrame(2, 9))
        controller.enqueue(queryFrame(3, 3))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      for (const r of interactionResponses(chunk)) {
        const idField = decodeFields(r).find((f) => f.no === 1)
        ids.push(idField ? (fieldVarint(idField) ?? 0) : 0)
        if (ids.length === 3 && ctrl) {
          ctrl.enqueue(turnEndedFrame())
          ctrl.close()
        }
      }
    })

    const run = (async () => {
      for await (const _ev of runCursorBidi(req, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        sessionId: "interaction-burst",
        modelId: "cursor-auto",
        networkClient: client,
      })) {
        // drain
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("turn hung on query burst")), 2000),
    )
    await Promise.race([run, timeout])
    expect(ids).toEqual([1, 2, 3])
  })
})
