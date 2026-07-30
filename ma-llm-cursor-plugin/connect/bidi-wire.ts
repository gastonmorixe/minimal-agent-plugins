/**
 * Connect bidi stream over the host NetworkClient (observed h2, net-dbg).
 *
 * @module llm/providers/cursor/connect/bidi-wire
 */

import { cursorBidiLog } from "../bidi-debug.ts"
import type { NetworkClient, NetworkResponse } from "../lib/net-types.ts"

import { type ConnectEnvelope, ConnectFrameReader, connectFrameProto } from "./stream.ts"

export type CursorBidiWire = {
  writeProto(payload: Uint8Array): void
  close(): void
  envelopes(signal?: AbortSignal): AsyncGenerator<ConnectEnvelope>
}

export type OpenCursorBidiWireOpts = {
  url: string
  headers: Record<string, string>
  initialRunBody: Uint8Array
  signal?: AbortSignal
  networkClient: NetworkClient
}

/** Open AgentService/Run with a writable request stream via host Http2Transport. */
export async function openCursorBidiWire(opts: OpenCursorBidiWireOpts): Promise<CursorBidiWire> {
  const framed = connectFrameProto(opts.initialRunBody)
  const response = await opts.networkClient.request({
    label: "cursor-agent-run",
    method: "POST",
    url: opts.url,
    headers: opts.headers,
    body: framed,
    signal: opts.signal,
    protocol: "h2",
    allowFetchFallback: false,
    keepRequestOpen: true,
    capture: {
      requestBody: `base64:${Buffer.from(framed).toString("base64")}`,
      responseBody: false,
    },
  })
  if (!response.ok) {
    try {
      await response.body.cancel(`cursor AgentService/Run HTTP ${response.status}`)
    } catch {
      /* ignore */
    }
    throw new Error(`cursor AgentService/Run failed (${response.status})`)
  }
  if (!response.writeRequestBody) {
    throw new Error(
      "cursor bidi: host transport did not expose writeRequestBody (need h2 + keepRequestOpen)",
    )
  }
  return createBidiWireFromResponse(response)
}

/** Wrap a keep-open NetworkResponse as a Connect envelope reader + writer. */
export function createBidiWireFromResponse(response: NetworkResponse): CursorBidiWire {
  const frameReader = new ConnectFrameReader()
  const bodyReader = response.body.getReader()
  const queue: ConnectEnvelope[] = []
  let waiters: Array<(next: ConnectEnvelope | "closed") => void> = []
  let closed = false
  let pumpError: Error | undefined

  const flushWaiters = (kind: ConnectEnvelope | "closed") => {
    for (const w of waiters) w(kind)
    waiters = []
  }

  const enqueue = (env: ConnectEnvelope) => {
    cursorBidiLog("wire.rx", {
      payloadBytes: env.payload.length,
      endStream: env.endStream,
      queueDepth: queue.length + 1,
      hasWaiter: waiters.length > 0,
    })
    const waiter = waiters.shift()
    if (waiter) waiter(env)
    else queue.push(env)
  }

  const waitNext = (): Promise<ConnectEnvelope | "closed"> =>
    new Promise((resolve) => {
      waiters.push(resolve)
    })

  const close = () => {
    if (closed) return
    closed = true
    try {
      response.endRequestBody?.()
    } catch {
      /* ignore */
    }
    void bodyReader.cancel().catch(() => undefined)
    flushWaiters("closed")
  }

  // One background pump for the wire lifetime — multiple envelopes() consumers
  // can pause/resume (tool round) without detaching the body reader.
  void (async () => {
    try {
      while (!closed) {
        const { done, value } = await bodyReader.read()
        if (done) {
          cursorBidiLog("wire.body-done")
          closed = true
          flushWaiters("closed")
          return
        }
        if (value && value.byteLength > 0) {
          for (const env of frameReader.push(value)) {
            enqueue(env)
          }
        }
      }
    } catch (err) {
      pumpError = err instanceof Error ? err : new Error(String(err))
      cursorBidiLog("wire.pump-error", { message: pumpError.message })
      closed = true
      flushWaiters("closed")
    } finally {
      try {
        bodyReader.releaseLock()
      } catch {
        /* ignore */
      }
    }
  })()

  return {
    writeProto(payload: Uint8Array) {
      if (closed) throw new Error("cursor bidi wire: closed")
      const framed = connectFrameProto(payload)
      cursorBidiLog("wire.write", { protoBytes: payload.length, framedBytes: framed.length })
      response.writeRequestBody!(framed)
    },
    close,
    async *envelopes(signal?: AbortSignal): AsyncGenerator<ConnectEnvelope> {
      const onAbort = () => close()
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        while (!closed || queue.length > 0) {
          const next = queue.shift() ?? (await waitNext())
          if (next === "closed") {
            if (pumpError) throw pumpError
            return
          }
          yield next
        }
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },
  }
}
