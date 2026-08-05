/** Regression tests for the host-backed bidi wire lifecycle. */

import { describe, expect, test } from "bun:test"

import type { NetworkResponse } from "../lib/net-types.ts"

import { createBidiWireFromResponse } from "./bidi-wire.ts"

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

describe("cursor bidi wire lifecycle", () => {
  test("marks the wire closed when the response body ends", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const wire = createBidiWireFromResponse(response(stream, () => undefined))

    expect(wire.isClosed()).toBe(false)
    const envelopes = wire.envelopes()
    await expect(envelopes.next()).resolves.toEqual({ done: true, value: undefined })
    expect(wire.isClosed()).toBe(true)
    expect(() => wire.writeProto(new Uint8Array([1]))).toThrow("cursor bidi wire: closed")
  })

  test("explicit close is idempotent and prevents later writes", () => {
    let writes = 0
    const stream = new ReadableStream<Uint8Array>()
    const wire = createBidiWireFromResponse(response(stream, () => writes++))

    wire.close()
    wire.close()
    expect(wire.isClosed()).toBe(true)
    expect(writes).toBe(0)
    expect(() => wire.writeProto(new Uint8Array([1]))).toThrow("cursor bidi wire: closed")
  })
})
