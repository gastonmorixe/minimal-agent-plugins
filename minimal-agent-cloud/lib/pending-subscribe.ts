/**
 * `pendingPromptAdded` subscription client — the graphql-transport-ws protocol
 * implemented directly over Bun's NATIVE WebSocket, dependency-free.
 *
 * ## Why no graphql-ws npm dep
 *
 * Same discipline as the rest of this plugin (plain `fetch` for device-auth +
 * ingest): the graphql-transport-ws protocol is tiny and stable, and adding the
 * `graphql-ws` package would pollute the shared plugins node_modules. Bun ships a
 * global `WebSocket`, so we speak the protocol ourselves. The server is standard
 * graphql-ws (confirmed against apps/api), so this interoperates exactly.
 *
 * ## The protocol (graphql-transport-ws)
 *
 *   client sends `connection_init` with a payload carrying the Bearer; the server
 *   replies `connection_ack`; the client sends `subscribe` (id + query +
 *   variables); the server streams `next` messages (one per event), then `error`
 *   or `complete`; the client sends `complete` to stop; either side may
 *   `ping`/`pong` for keepalive.
 *
 * The connection is best-effort: on socket error/close we surface it via the
 * `onError` callback and stop; the caller (the attach handler) reconnects and
 * re-drains via the `pendingPrompts` query so nothing is lost (the subscription
 * is the LIVE fast-path, the query is the source-of-truth catch-up).
 *
 * @module lib/pending-subscribe
 */

/** The WebSocket ctor shape we need (Bun's global, or an injected fake for tests). */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: unknown) => void): void
}
export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike

/** Options for {@link subscribePendingPrompts}. */
export interface SubscribeOptions<T> {
  /** ws:// or wss:// graphql endpoint. */
  readonly url: string
  /** Bearer token sent in connection_init payload (connectionParams.authorization). */
  readonly bearer: string
  /** The GraphQL subscription document. */
  readonly query: string
  /** Variables (for example, the sid). */
  readonly variables: Record<string, unknown>
  /** Called for each `next` payload's `data`. */
  readonly onNext: (data: T) => void
  /** Called once on a terminal error (socket or GraphQL). */
  readonly onError?: (reason: string) => void
  /** Called when the server sends `complete`. */
  readonly onComplete?: () => void
  /** WebSocket factory. Defaults to Bun's global WebSocket. Injected for tests. */
  readonly makeSocket?: WebSocketFactory
}

/** Handle to stop a subscription. */
export interface Subscription {
  /** Send `complete` + close the socket. Idempotent. */
  unsubscribe(): void
}

const SUBPROTOCOL = "graphql-transport-ws"

/**
 * Open a `pendingPromptAdded` (or any) graphql-ws subscription. Returns a handle
 * to stop it. Never throws — connection problems route to `onError`.
 */
export function subscribePendingPrompts<T = unknown>(opts: SubscribeOptions<T>): Subscription {
  const make = opts.makeSocket ?? defaultFactory()
  const id = `sub-${Math.random().toString(36).slice(2)}`
  let acked = false
  let closed = false
  let ws: WebSocketLike

  const fail = (reason: string) => {
    if (closed) return
    closed = true
    opts.onError?.(reason)
    try {
      ws?.close(1000, "client error")
    } catch {
      // ignore
    }
  }

  try {
    ws = make(opts.url, SUBPROTOCOL)
  } catch (e) {
    opts.onError?.(`socket construct failed: ${e instanceof Error ? e.message : String(e)}`)
    return { unsubscribe() {} }
  }

  const send = (obj: unknown) => {
    try {
      ws.send(JSON.stringify(obj))
    } catch (e) {
      fail(`send failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  ws.addEventListener("open", () => {
    // connection_init carries the Bearer as connectionParams.authorization.
    send({ type: "connection_init", payload: { authorization: `Bearer ${opts.bearer}` } })
  })

  ws.addEventListener("message", (ev: unknown) => {
    const raw = (ev as { data?: unknown }).data
    let msg: { type?: string; id?: string; payload?: unknown }
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw))
    } catch {
      return // ignore unparseable frames
    }
    switch (msg.type) {
      case "connection_ack":
        acked = true
        send({ type: "subscribe", id, payload: { query: opts.query, variables: opts.variables } })
        break
      case "next": {
        if (msg.id !== id) return
        const data = (msg.payload as { data?: T } | undefined)?.data
        if (data !== undefined) opts.onNext(data)
        break
      }
      case "error": {
        if (msg.id !== id) return
        const errs = msg.payload as { message?: string }[] | undefined
        fail(`subscription error: ${errs?.[0]?.message ?? "unknown"}`)
        break
      }
      case "complete":
        if (msg.id === id) {
          opts.onComplete?.()
          if (!closed) {
            closed = true
            try {
              ws.close(1000, "done")
            } catch {
              // ignore
            }
          }
        }
        break
      case "ping":
        send({ type: "pong" })
        break
      default:
        break
    }
  })

  ws.addEventListener("error", () => fail("websocket error"))
  ws.addEventListener("close", () => {
    if (!closed) {
      closed = true
      // A close before ack is a connection failure; after ack it's a normal end.
      if (!acked) opts.onError?.("socket closed before connection_ack")
    }
  })

  return {
    unsubscribe() {
      if (closed) return
      closed = true
      send({ type: "complete", id })
      try {
        ws.close(1000, "unsubscribe")
      } catch {
        // ignore
      }
    },
  }
}

/** The default factory wrapping Bun's global WebSocket. */
function defaultFactory(): WebSocketFactory {
  return (url, protocols) => {
    const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as
      | (new (
          u: string,
          p?: string | string[],
        ) => WebSocketLike)
      | undefined
    if (!Ctor) throw new Error("no global WebSocket (Bun provides one)")
    return new Ctor(url, protocols)
  }
}

/** The pendingPromptAdded subscription document (contract v3). */
export const PENDING_ADDED_SUBSCRIPTION =
  "subscription($sid:ID!){pendingPromptAdded(sid:$sid){pendingId sid content status createdAt}}"
