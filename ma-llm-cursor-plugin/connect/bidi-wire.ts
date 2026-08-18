/**
 * Connect bidi stream over the host NetworkClient (observed h2, net-dbg).
 *
 * @module llm/providers/cursor/connect/bidi-wire
 */

import { cursorBidiLog } from "../bidi-debug.ts"
import type { NetworkClient, NetworkResponse } from "../lib/net-types.ts"
import { encodeAgentClientMessageHeartbeat } from "../proto/client-message.ts"

import { type ConnectEnvelope, ConnectFrameReader, connectFrameProto } from "./stream.ts"

/** Official Cursor Agent CLI interval for AgentClientMessage.client_heartbeat. */
export const CURSOR_BIDI_HEARTBEAT_INTERVAL_MS = 5_000

/**
 * Heartbeat period for a keep-open AgentService/Run stream.
 * `MA_CURSOR_BIDI_HEARTBEAT_MS=0` disables; unset uses {@link CURSOR_BIDI_HEARTBEAT_INTERVAL_MS}.
 */
export function cursorBidiHeartbeatIntervalMs(): number {
  const raw = process.env.MA_CURSOR_BIDI_HEARTBEAT_MS?.trim()
  if (raw === undefined || raw === "") return CURSOR_BIDI_HEARTBEAT_INTERVAL_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return CURSOR_BIDI_HEARTBEAT_INTERVAL_MS
  return n
}

export type CursorBidiWire = {
  writeProto(payload: Uint8Array): void
  close(): void
  /** True after the response stream has ended or the wire was explicitly closed. */
  isClosed(): boolean
  envelopes(signal?: AbortSignal): AsyncGenerator<ConnectEnvelope>
}

export type OpenCursorBidiWireOpts = {
  url: string
  headers: Record<string, string>
  initialRunBody: Uint8Array
  signal?: AbortSignal
  networkClient: NetworkClient
  /** Override heartbeat interval (ms). `0` disables. Default: {@link cursorBidiHeartbeatIntervalMs}. */
  heartbeatIntervalMs?: number
}

export type CreateBidiWireOpts = {
  /** Override heartbeat interval (ms). `0` disables. Default: {@link cursorBidiHeartbeatIntervalMs}. */
  heartbeatIntervalMs?: number
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
  return createBidiWireFromResponse(response, {
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
  })
}

/** Wrap a keep-open NetworkResponse as a Connect envelope reader + writer. */
export function createBidiWireFromResponse(
  response: NetworkResponse,
  opts: CreateBidiWireOpts = {},
): CursorBidiWire {
  const frameReader = new ConnectFrameReader()
  const bodyReader = response.body.getReader()
  const queue: ConnectEnvelope[] = []
  let waiters: Array<(next: ConnectEnvelope | "closed") => void> = []
  let closed = false
  let pumpError: Error | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? cursorBidiHeartbeatIntervalMs()

  const flushWaiters = (kind: ConnectEnvelope | "closed") => {
    for (const w of waiters) w(kind)
    waiters = []
  }

  const stopHeartbeats = () => {
    if (heartbeatTimer === undefined) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }

  const markClosed = (err?: Error) => {
    if (closed) return
    closed = true
    stopHeartbeats()
    if (err) pumpError = err
    flushWaiters("closed")
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

  const writeProto = (payload: Uint8Array) => {
    if (closed) throw new Error("cursor bidi wire: closed")
    const framed = connectFrameProto(payload)
    cursorBidiLog("wire.write", { protoBytes: payload.length, framedBytes: framed.length })
    response.writeRequestBody!(framed)
  }

  const close = () => {
    if (closed) return
    markClosed()
    try {
      response.endRequestBody?.()
    } catch {
      /* ignore */
    }
    void bodyReader.cancel().catch(() => undefined)
  }

  // One background pump for the wire lifetime — multiple envelopes() consumers
  // can pause/resume (tool round) without detaching the body reader.
  void (async () => {
    try {
      while (!closed) {
        const { done, value } = await bodyReader.read()
        if (done) {
          cursorBidiLog("wire.body-done")
          markClosed()
          return
        }
        if (value && value.byteLength > 0) {
          for (const env of frameReader.push(value)) {
            enqueue(env)
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      cursorBidiLog("wire.pump-error", { message: error.message })
      markClosed(error)
    } finally {
      stopHeartbeats()
      try {
        bodyReader.releaseLock()
      } catch {
        /* ignore */
      }
    }
  })()

  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (closed) {
        stopHeartbeats()
        return
      }
      try {
        cursorBidiLog("wire.heartbeat", { intervalMs: heartbeatIntervalMs })
        writeProto(encodeAgentClientMessageHeartbeat())
      } catch {
        stopHeartbeats()
      }
    }, heartbeatIntervalMs)
  }

  return {
    writeProto,
    close,
    isClosed() {
      return closed
    },
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
