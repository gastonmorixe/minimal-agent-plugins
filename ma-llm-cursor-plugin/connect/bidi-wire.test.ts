/** Regression tests for the host-backed bidi wire lifecycle. */

import { describe, expect, test } from "bun:test"

import type { NetworkResponse } from "../lib/net-types.ts"
import { decodeFields, encMsg, encString } from "../proto/wire.ts"

import { createBidiWireFromResponse } from "./bidi-wire.ts"
import { connectFrameProto, parseConnectFrames } from "./stream.ts"

function response(
  body: ReadableStream<Uint8Array>,
  writeRequestBody: (chunk: Uint8Array) => void,
): NetworkResponse {
  return {
    status: 200,
    headers: new Headers(),
    body,
    transport: { id: "test", protocol: "h2" },
    ok: true,
    text: async () => "",
    json: async <T>() => ({}) as T,
    writeRequestBody,
  }
}

function isHeartbeatFrame(chunk: Uint8Array): boolean {
  return parseConnectFrames(chunk).some((frame) =>
    decodeFields(frame.payload).some((field) => field.no === 7),
  )
}

describe("cursor bidi wire lifecycle", () => {
  test("marks the wire closed when the response body ends", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const wire = createBidiWireFromResponse(
      response(stream, () => undefined),
      {
        heartbeatIntervalMs: 0,
      },
    )

    expect(wire.isClosed()).toBe(false)
    const envelopes = wire.envelopes()
    await expect(envelopes.next()).resolves.toEqual({ done: true, value: undefined })
    expect(wire.isClosed()).toBe(true)
    expect(() => wire.writeProto(new Uint8Array([1]))).toThrow("cursor bidi wire: closed")
  })

  test("explicit close is idempotent and prevents later writes", () => {
    let writes = 0
    const stream = new ReadableStream<Uint8Array>()
    const wire = createBidiWireFromResponse(
      response(stream, () => writes++),
      {
        heartbeatIntervalMs: 0,
      },
    )

    wire.close()
    wire.close()
    expect(wire.isClosed()).toBe(true)
    expect(writes).toBe(0)
    expect(() => wire.writeProto(new Uint8Array([1]))).toThrow("cursor bidi wire: closed")
  })

  test("writes client_heartbeat frames until close", async () => {
    const writes: Uint8Array[] = []
    const stream = new ReadableStream<Uint8Array>()
    const wire = createBidiWireFromResponse(
      response(stream, (chunk) => writes.push(chunk)),
      {
        heartbeatIntervalMs: 20,
      },
    )

    await Bun.sleep(55)
    wire.close()

    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(isHeartbeatFrame(writes[0]!)).toBe(true)

    const afterClose = writes.length
    await Bun.sleep(40)
    expect(writes.length).toBe(afterClose)
  })

  test("unblocks a text-only turn when the server waits for a client heartbeat", async () => {
    const textFrame = connectFrameProto(encMsg(1, encMsg(1, encString(1, "hello"))))
    const turnEndedFrame = connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0))))
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    let sentTurnEnded = false

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(textFrame)
      },
    })

    const wire = createBidiWireFromResponse(
      response(stream, (chunk) => {
        if (!isHeartbeatFrame(chunk) || sentTurnEnded || !bodyController) return
        sentTurnEnded = true
        bodyController.enqueue(turnEndedFrame)
        bodyController.close()
      }),
      { heartbeatIntervalMs: 20 },
    )

    const interactionFields: number[] = []
    const deadline = Date.now() + 1_000
    for await (const env of wire.envelopes()) {
      for (const f of decodeFields(env.payload)) {
        if (f.no !== 1 || f.wire !== 2 || !(f.value instanceof Uint8Array)) continue
        for (const inner of decodeFields(f.value)) interactionFields.push(inner.no)
      }
      if (interactionFields.includes(14) || Date.now() > deadline) break
    }
    wire.close()

    expect(interactionFields).toContain(1)
    expect(interactionFields).toContain(14)
    expect(sentTurnEnded).toBe(true)
  })
})
