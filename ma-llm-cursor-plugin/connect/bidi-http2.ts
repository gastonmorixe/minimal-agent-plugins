/**
 * Bidirectional HTTP/2 Connect stream for Cursor AgentService/Run.
 *
 * Cursor keeps the request stream open after the initial run_request frame so
 * the client can write exec_client_message (MCP tool results) while reading
 * server interaction_update / exec_server_message frames.
 *
 * The host NetworkClient is request/response only — it cannot write mid-stream.
 * This module uses node:http2 directly for the product path when MCP tools are
 * enabled (still observed via net-dbg when MINIMAL_AGENT_NET_DBG=1 on the
 * read side through the adapter's debug sink).
 *
 * @module llm/providers/cursor/connect/bidi-http2
 */

import { connectFrameProto } from "./stream.ts"

export type BidiHttp2PostOptions = {
  url: string
  headers: Record<string, string>
  /** First Connect frame(s) — typically the run_request AgentClientMessage. */
  initialBody: Uint8Array
  signal?: AbortSignal
}

export type BidiHttp2Session = {
  /** Server → client Connect frame payloads (may be gzip-compressed at envelope level). */
  readChunks(): AsyncGenerator<Uint8Array>
  /** Client → server: write one Connect envelope frame. */
  writeFrame(payload: Uint8Array, gzip?: boolean): void
  /** Half-close the request side when no more client frames will be sent. */
  endRequest(): void
  /** Force-close the stream. */
  close(): void
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new Error("cursor bidi stream: aborted")
}

/**
 * Open a bidi HTTP/2 POST to AgentService/Run.
 *
 * Writes `initialBody` immediately, then yields response DATA chunks until the
 * server closes or `signal` aborts. Additional request frames can be sent via
 * {@link BidiHttp2Session.writeFrame} before {@link BidiHttp2Session.endRequest}.
 */
export async function openBidiHttp2Stream(opts: BidiHttp2PostOptions): Promise<BidiHttp2Session> {
  throwIfAborted(opts.signal)
  const http2 = await import("node:http2")
  const url = new URL(opts.url)
  const client = http2.connect(`${url.protocol}//${url.host}`, {
    rejectUnauthorized: true,
  })

  const closeClient = () => {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      closeClient()
      throwIfAborted(opts.signal)
    }
    opts.signal.addEventListener("abort", closeClient, { once: true })
  }

  const h2Headers: Record<string, string | string[]> = {
    ":method": "POST",
    ":path": `${url.pathname}${url.search}`,
    ":scheme": url.protocol.replace(":", ""),
    ":authority": url.host,
  }
  for (const [k, v] of Object.entries(opts.headers)) {
    const lower = k.toLowerCase()
    if (lower === "connection" || lower === "transfer-encoding" || lower === "host") continue
    h2Headers[k] = v
  }

  const stream = client.request(h2Headers)
  stream.write(Buffer.from(opts.initialBody))

  let ended = false
  let err: Error | undefined
  const chunks: Uint8Array[] = []
  let resolveWait: (() => void) | undefined
  const wait = () =>
    new Promise<void>((r) => {
      resolveWait = r
    })
  const wake = () => {
    resolveWait?.()
    resolveWait = undefined
  }

  stream.on("data", (chunk: Buffer | Uint8Array) => {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
    wake()
  })
  stream.on("end", () => {
    ended = true
    wake()
  })
  stream.on("error", (e: Error) => {
    err = e
    ended = true
    wake()
  })
  stream.on("close", () => {
    ended = true
    wake()
  })

  let requestEnded = false

  const session: BidiHttp2Session = {
    async *readChunks(): AsyncGenerator<Uint8Array> {
      while (!ended || chunks.length > 0) {
        if (err) throw err
        if (chunks.length === 0) {
          if (ended) break
          await wait()
          continue
        }
        yield chunks.shift()!
      }
      if (err) throw err
    },

    writeFrame(payload: Uint8Array, gzip = false): void {
      throwIfAborted(opts.signal)
      if (requestEnded) {
        throw new Error("cursor bidi stream: request side already ended")
      }
      const framed = connectFrameProto(payload, gzip)
      stream.write(Buffer.from(framed))
    },

    endRequest(): void {
      if (requestEnded) return
      requestEnded = true
      try {
        stream.end()
      } catch {
        /* ignore */
      }
    },

    close(): void {
      try {
        stream.close()
      } catch {
        /* ignore */
      }
      closeClient()
    },
  }

  return session
}
