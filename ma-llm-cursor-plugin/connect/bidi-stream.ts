/**
 * Bidirectional HTTP/2 Connect stream for AgentService/Run.
 *
 * Cursor keeps the h2 stream open: client writes run_request, then
 * exec_client_message tool results, while server streams AgentServerMessage frames.
 *
 * Uses node:http2 directly (host NetworkClient ends the request body after one write).
 *
 * @module llm/providers/cursor/connect/bidi-stream
 */

import type { ClientHttp2Stream } from "node:http2"

import { type ConnectEnvelope, ConnectFrameReader, connectFrameProto } from "./stream.ts"

export type CursorBidiStreamOptions = {
  url: string
  headers: Record<string, string>
  initialBody: Uint8Array
  signal?: AbortSignal
}

/** Live bidirectional AgentService/Run stream. */
export class CursorBidiStream {
  private readonly reader = new ConnectFrameReader()
  private readonly queue: ConnectEnvelope[] = []
  private waiters: Array<(env: ConnectEnvelope | "closed" | "error") => void> = []
  private closed = false
  private error: Error | undefined
  private readonly stream: ClientHttp2Stream
  private readonly closeHttp2: () => void

  private constructor(stream: ClientHttp2Stream, closeHttp2: () => void) {
    this.stream = stream
    this.closeHttp2 = closeHttp2
  }

  /** Open stream, write the initial Connect-framed run_request, keep writable. */
  static async open(opts: CursorBidiStreamOptions): Promise<CursorBidiStream> {
    const http2 = await import("node:http2")
    const url = new URL(opts.url)
    const client = http2.connect(`${url.protocol}//${url.host}`, { rejectUnauthorized: true })

    const closeHttp2 = () => {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }

    if (opts.signal?.aborted) {
      closeHttp2()
      throw opts.signal.reason ?? new Error("cursor bidi stream: aborted")
    }
    opts.signal?.addEventListener("abort", closeHttp2, { once: true })

    const h2Headers: Record<string, string | string[]> = {
      ":method": "POST",
      ":path": `${url.pathname}${url.search}`,
      ":scheme": url.protocol.replace(":", ""),
      ":authority": url.host,
    }
    for (const [k, v] of Object.entries(opts.headers)) {
      if (k.toLowerCase() === "connection" || k.toLowerCase() === "transfer-encoding") continue
      h2Headers[k] = v
    }

    const stream = client.request(h2Headers)
    const bidi = new CursorBidiStream(stream, closeHttp2)

    stream.on("data", (chunk: Buffer | Uint8Array) => {
      bidi.pushChunk(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
    })
    stream.on("end", () => bidi.finish())
    stream.on("error", (err: Error) => bidi.fail(err))

    stream.write(Buffer.from(opts.initialBody))
    return bidi
  }

  /** Write another Connect-framed AgentClientMessage payload. */
  writeProto(payload: Uint8Array): void {
    if (this.closed) throw new Error("cursor bidi stream: closed")
    const framed = connectFrameProto(payload)
    this.stream.write(Buffer.from(framed))
  }

  /** End the writable side and tear down the HTTP/2 session. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.stream.end()
    } catch {
      /* ignore */
    }
    this.closeHttp2()
    this.flushWaiters("closed")
  }

  /** Async iterator over complete Connect envelopes from the server. */
  async *envelopes(signal?: AbortSignal): AsyncGenerator<ConnectEnvelope> {
    const onAbort = () => {
      this.close()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      while (!this.closed || this.queue.length > 0) {
        const next = this.queue.shift() ?? (await this.waitNext())
        if (next === "closed") return
        if (next === "error") throw this.error ?? new Error("cursor bidi stream: error")
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  private pushChunk(chunk: Uint8Array): void {
    for (const env of this.reader.push(chunk)) {
      this.enqueue(env)
    }
  }

  private finish(): void {
    this.closed = true
    this.flushWaiters("closed")
  }

  private fail(err: Error): void {
    this.error = err
    this.closed = true
    this.flushWaiters("error")
  }

  private enqueue(env: ConnectEnvelope): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(env)
    else this.queue.push(env)
  }

  private waitNext(): Promise<ConnectEnvelope | "closed" | "error"> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private flushWaiters(kind: "closed" | "error"): void {
    for (const w of this.waiters) w(kind)
    this.waiters = []
  }
}
