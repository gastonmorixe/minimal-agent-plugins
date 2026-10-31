/**
 * Hand-rolled JSON-RPC 2.0 over NDJSON stdio. Zero runtime dependencies —
 * no `@agentclientprotocol/sdk`, not even as a test client (team decision,
 * `acp-decisions.md` item 3). Built directly on Bun/Node stream primitives,
 * starting from the proven spike (`research/acp-spike/agent.ts` in the
 * `minimal-agent` umbrella repo, label "Verified Offline": a real spawn
 * showed 9 stdout lines, 0 non-JSON-RPC, cancel mid-turn working, logs on
 * stderr only).
 *
 * THE RULE this module exists to enforce: stdout carries ONLY valid
 * JSON-RPC 2.0 messages, one per line, UTF-8, no embedded newline. `write`
 * is the ONE function that may touch the caller-supplied sink — route
 * every other byte (host-mode logs, a handler's own diagnostics) to
 * stderr instead, never here.
 *
 * Scope: request/response/notification dispatch (agent reads, client
 * writes), PLUS agent-to-client requests ({@link RpcChannel.request}, for
 * `session/request_permission` later) with id correlation and
 * cancellation. A maximum message-size guard drops an oversize line
 * without ever parsing it (same NDJSON semantics the spike proved under
 * `research/acp-spike/framer-test.ts`: a line above the limit is dropped
 * whole, one error per line, the stream recovers at the next newline).
 *
 * @module transport
 */

/** A JSON-RPC 2.0 id: a number or a string, never `null` for a real request. */
export type JsonRpcId = number | string

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly result: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId | null
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/** Standard JSON-RPC 2.0 error codes this transport uses. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

/** Thrown by a request handler to control the JSON-RPC error code sent back. */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

/** One side's method table: requests (must reply) and notifications (must not). */
export interface RpcHandlers {
  readonly requests: Readonly<Record<string, (params: unknown) => unknown>>
  readonly notifications: Readonly<Record<string, (params: unknown) => void>>
}

/** What {@link createRpcChannel} returns: send-side API plus the running read loop. */
export interface RpcChannel {
  /** Send a notification (no reply expected). */
  notify(method: string, params?: unknown): void
  /**
   * Send an agent-to-client REQUEST and await its reply (for
   * `session/request_permission`, later `fs/*`/`terminal/*`). Rejects on a
   * JSON-RPC error reply, or when `signal` aborts first (the pending entry
   * is removed either way — a late reply for an aborted request is
   * ignored, not an error).
   */
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>
  /** Resolves once the read side hits EOF (stdin closed) or `stop()` is called. */
  readonly closed: Promise<void>
  /** Stop reading. Pending outgoing `request()` calls reject with "channel stopped". */
  stop(): void
}

/** Max bytes a single NDJSON line may hold before it is dropped whole (8 MiB, the spike's figure). */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

export interface CreateRpcChannelOptions {
  /** The host's read stream (`ctx.stdin`). */
  readonly stdin: AsyncIterable<Uint8Array | Buffer | string>
  /**
   * The ONE function allowed to write a JSON-RPC line (bind it to
   * `ctx.stdout.write`, never call `ctx.stdout.write` from anywhere else).
   */
  readonly write: (line: string) => void
  readonly handlers: RpcHandlers
  /** Diagnostics only — never a protocol message. Defaults to a no-op. */
  readonly log?: (message: string) => void
  readonly maxLineBytes?: number
}

/**
 * Wire up a bidirectional JSON-RPC 2.0 channel over NDJSON. Starts reading
 * `stdin` immediately; the returned `closed` promise settles when the
 * stream ends. Call sites: `createRpcChannel({...}).closed` as the
 * handler's main await.
 */
export function createRpcChannel(options: CreateRpcChannelOptions): RpcChannel {
  const { stdin, write, handlers, log = () => {}, maxLineBytes = DEFAULT_MAX_LINE_BYTES } = options

  const pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  let nextOutId = 1
  let stopped = false

  const send = (msg: unknown): void => write(`${JSON.stringify(msg)}\n`)
  const sendOk = (id: JsonRpcId, result: unknown): void => send({ jsonrpc: "2.0", id, result })
  const sendFail = (id: JsonRpcId | null, code: number, message: string, data?: unknown): void =>
    send({
      jsonrpc: "2.0",
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    })

  async function dispatchLine(line: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      sendFail(null, RPC_ERROR.parse, "parse error")
      return
    }
    if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // A reply to one of OUR outgoing requests lands here too (id present,
      // method absent): handle it before falling through to "invalid".
      if (
        isRecord(msg) &&
        (msg.id === 0 || typeof msg.id === "number" || typeof msg.id === "string")
      ) {
        const waiter = pending.get(msg.id)
        if (waiter) {
          pending.delete(msg.id)
          if ("error" in msg && isRecord(msg.error)) {
            waiter.reject(new RpcError(Number(msg.error.code), String(msg.error.message)))
          } else {
            waiter.resolve((msg as { result?: unknown }).result)
          }
          return
        }
      }
      if (isRecord(msg) && msg.id !== undefined) {
        sendFail(normalizeId(msg.id), RPC_ERROR.invalidRequest, "invalid request")
      }
      return
    }
    const isRequest = msg.id !== undefined
    if (!isRequest) {
      const notification = handlers.notifications[msg.method]
      if (notification) {
        try {
          notification(msg.params)
        } catch (e) {
          log(`notification handler "${msg.method}" threw: ${describeError(e)}`)
        }
      }
      return
    }
    const id = normalizeId(msg.id)
    const handler = handlers.requests[msg.method]
    if (!handler) {
      sendFail(id, RPC_ERROR.methodNotFound, `method not found: ${msg.method}`)
      return
    }
    try {
      sendOk(id, await handler(msg.params))
    } catch (e) {
      if (e instanceof RpcError) sendFail(id, e.code, e.message, e.data)
      else sendFail(id, RPC_ERROR.internal, describeError(e))
    }
  }

  let settleClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve
  })

  void (async (): Promise<void> => {
    // NDJSON framer. The size guard is bounded PER CHUNK (a client may
    // send one huge chunk with no newline), and an oversize line is
    // dropped WHOLE at the next newline, never parsed — see
    // `research/acp-spike/framer-test.ts` in the umbrella repo for the
    // exact cases this mirrors (A/A2/B/C/D).
    let buf = ""
    let discarding = false
    const dec = new TextDecoder()
    for await (const chunk of stdin) {
      if (stopped) break
      const text = dec.decode(toBytes(chunk), { stream: true })
      let rest = text
      while (rest.length > 0) {
        const nl = rest.indexOf("\n")
        const piece = nl >= 0 ? rest.slice(0, nl) : rest
        if (!discarding) {
          if (buf.length + piece.length > maxLineBytes) {
            sendFail(null, RPC_ERROR.invalidRequest, "message too large")
            buf = ""
            discarding = true
          } else {
            buf += piece
          }
        }
        if (nl < 0) break
        if (!discarding) {
          const line = buf.trim()
          if (line) void dispatchLine(line)
        }
        buf = ""
        discarding = false
        rest = rest.slice(nl + 1)
      }
    }
    for (const waiter of pending.values()) waiter.reject(new Error("channel closed"))
    pending.clear()
    settleClosed()
  })()

  return {
    notify(method, params): void {
      send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
    },
    request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
      const id = nextOutId++
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
          pending.delete(id)
          reject(signal?.reason ?? new Error("request aborted"))
        }
        pending.set(id, {
          resolve: (v) => {
            signal?.removeEventListener("abort", onAbort)
            resolve(v as T)
          },
          reject: (e) => {
            signal?.removeEventListener("abort", onAbort)
            reject(e)
          },
        })
        if (signal) {
          if (signal.aborted) return onAbort()
          signal.addEventListener("abort", onAbort, { once: true })
        }
        send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
      })
    },
    closed,
    stop(): void {
      stopped = true
      for (const waiter of pending.values()) waiter.reject(new Error("channel stopped"))
      pending.clear()
      settleClosed()
    },
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

function normalizeId(id: unknown): JsonRpcId {
  return typeof id === "number" || typeof id === "string" ? id : String(id)
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function toBytes(chunk: Uint8Array | Buffer | string): Uint8Array {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
}
