/**
 * Connect streaming envelope helpers (application/connect+proto).
 * Frame: [flags u8][length u32 BE][payload]
 * flags bit0 = gzip-compressed payload
 * flags bit1 = end-stream / trailer (JSON error metadata often)
 *
 * @module llm/providers/cursor/connect/stream
 */

import { gunzipSync, gzipSync } from "node:zlib"

/** Build one Connect envelope frame. */
export function connectFrame(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = flags & 0xff
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}

/** Frame a protobuf payload (optionally gzip). */
export function connectFrameProto(payload: Uint8Array, gzip = false): Uint8Array {
  if (gzip) {
    const gz = gzipSync(payload)
    return connectFrame(0x01, gz)
  }
  return connectFrame(0x00, payload)
}

/** One parsed Connect envelope. */
export type ConnectEnvelope = {
  flags: number
  compressed: boolean
  endStream: boolean
  payload: Uint8Array
  rawPayload: Uint8Array
}

/** Parse a complete buffer of Connect frames (offline fixtures). */
export function parseConnectFrames(buf: Uint8Array): ConnectEnvelope[] {
  const frames: ConnectEnvelope[] = []
  let i = 0
  while (i + 5 <= buf.length) {
    const flags = buf[i]!
    const len = new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0, false)
    i += 5
    if (i + len > buf.length) break
    const raw = buf.subarray(i, i + len)
    i += len
    const compressed = (flags & 0x01) !== 0
    const endStream = (flags & 0x02) !== 0
    let payload = raw
    if (compressed && raw.length > 0) {
      try {
        payload = new Uint8Array(gunzipSync(raw))
      } catch {
        payload = raw
      }
    }
    frames.push({ flags, compressed, endStream, payload, rawPayload: raw })
  }
  return frames
}

/** Incremental parser for streaming response bodies. */
export class ConnectFrameReader {
  private buf = new Uint8Array(0)

  /** Push a chunk; return any complete frames. */
  push(chunk: Uint8Array): ConnectEnvelope[] {
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
    const out: ConnectEnvelope[] = []
    while (this.buf.length >= 5) {
      const flags = this.buf[0]!
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + 1, 4).getUint32(0, false)
      if (this.buf.length < 5 + len) break
      const raw = this.buf.subarray(5, 5 + len)
      this.buf = this.buf.subarray(5 + len)
      const compressed = (flags & 0x01) !== 0
      const endStream = (flags & 0x02) !== 0
      let payload = raw
      if (compressed && raw.length > 0) {
        try {
          payload = new Uint8Array(gunzipSync(raw))
        } catch {
          payload = raw
        }
      }
      out.push({ flags, compressed, endStream, payload, rawPayload: raw })
    }
    return out
  }

  /** Unconsumed bytes (incomplete frame). */
  remainder(): Uint8Array {
    return this.buf
  }
}

/**
 * POST a framed Connect+proto request and yield response body chunks.
 *
 * Product path: Node `http2` client (Bun fetch is malformed on this bidi stream).
 * Dev fallback: curl --http2 when `MA_CURSOR_STREAM_TRANSPORT=curl`.
 */
export async function* connectStreamPost(opts: {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}): AsyncGenerator<Uint8Array> {
  const transport = process.env.MA_CURSOR_STREAM_TRANSPORT ?? "http2"
  if (transport === "curl") {
    yield* connectStreamViaCurl(opts)
    return
  }
  yield* connectStreamViaHttp2(opts)
}

/** HTTP/2 client stream via node:http2. */
async function* connectStreamViaHttp2(opts: {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}): AsyncGenerator<Uint8Array> {
  const http2 = await import("node:http2")
  const url = new URL(opts.url)
  const client = http2.connect(`${url.protocol}//${url.host}`, {
    // Cursor uses public CA certs
    rejectUnauthorized: true,
  })

  const close = () => {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      close()
      throw new Error("cursor connect stream: aborted")
    }
    opts.signal.addEventListener("abort", close, { once: true })
  }

  try {
    const headers: Record<string, string | string[]> = {
      ":method": "POST",
      ":path": `${url.pathname}${url.search}`,
      ":scheme": url.protocol.replace(":", ""),
      ":authority": url.host,
    }
    for (const [k, v] of Object.entries(opts.headers)) {
      // HTTP/2 forbids connection-specific headers
      if (k.toLowerCase() === "connection" || k.toLowerCase() === "transfer-encoding") continue
      headers[k] = v
    }

    const stream = client.request(headers)

    const chunks: Uint8Array[] = []
    let ended = false
    let err: Error | undefined
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

    stream.end(Buffer.from(opts.body))

    while (!ended || chunks.length > 0) {
      if (err) throw err
      if (chunks.length === 0) {
        if (ended) break
        await wait()
        continue
      }
      const c = chunks.shift()!
      yield c
    }
    if (err) throw err
  } finally {
    close()
  }
}

/**
 * curl --http2 fallback (dev / last resort). Not the preferred product path.
 */
async function* connectStreamViaCurl(opts: {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}): AsyncGenerator<Uint8Array> {
  const tmp = await import("node:os").then((m) => m.tmpdir())
  const path = await import("node:path")
  const fs = await import("node:fs/promises")
  const bodyPath = path.join(tmp, `ma-cursor-run-req-${crypto.randomUUID()}.bin`)
  const respPath = path.join(tmp, `ma-cursor-run-resp-${crypto.randomUUID()}.bin`)
  await fs.writeFile(bodyPath, opts.body)

  const args = [
    "curl",
    "-sS",
    "--http2",
    "-o",
    respPath,
    "-X",
    "POST",
    opts.url,
    "--data-binary",
    `@${bodyPath}`,
    "--max-time",
    "120",
  ]
  for (const [k, v] of Object.entries(opts.headers)) {
    args.push("-H", `${k}: ${v}`)
  }

  try {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          try {
            p.kill()
          } catch {
            /* ignore */
          }
        },
        { once: true },
      )
    }
    const stderr = await new Response(p.stderr).text()
    const code = await p.exited
    if (code !== 0) {
      throw new Error(`cursor connect stream curl failed (${code}): ${stderr.slice(0, 500)}`)
    }
    const body = new Uint8Array(await fs.readFile(respPath))
    if (body.length > 0) yield body
  } finally {
    await fs.unlink(bodyPath).catch(() => undefined)
    await fs.unlink(respPath).catch(() => undefined)
  }
}
