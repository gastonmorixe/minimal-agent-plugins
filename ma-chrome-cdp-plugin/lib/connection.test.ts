import { describe, expect, test } from "bun:test"

import { CdpConnection, type MinimalSocket } from "./connection.ts"

/**
 * A fake CDP socket: records sent frames and lets the test push inbound
 * messages. `autoReply` answers each request id so `send()` promises resolve.
 */
class FakeSocket implements MinimalSocket {
  sent: Array<Record<string, unknown>> = []
  private handlers: Record<string, Array<(e: unknown) => void>> = {}
  autoReply: ((frame: Record<string, unknown>) => Record<string, unknown> | undefined) | null = null

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>
    this.sent.push(frame)
    if (this.autoReply) {
      const reply = this.autoReply(frame)
      if (reply) queueMicrotask(() => this.emit("message", { data: JSON.stringify(reply) }))
    }
  }
  close(): void {
    this.emit("close", undefined)
  }
  addEventListener(type: string, cb: (e: never) => void): void {
    ;(this.handlers[type] ??= []).push(cb as (e: unknown) => void)
  }
  emit(type: string, e: unknown): void {
    for (const cb of this.handlers[type] ?? []) cb(e)
  }
  /** push a raw inbound CDP message */
  push(msg: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(msg) })
  }
}

function connected(): { conn: CdpConnection; sock: FakeSocket } {
  const sock = new FakeSocket()
  const conn = new CdpConnection({ url: "ws://x", socketFactory: () => sock })
  const p = conn.connect()
  sock.emit("open", undefined)
  // connect() resolves on open; we don't need to await for sync assertions,
  // but return the promise-settled connection.
  void p
  return { conn, sock }
}

describe("connect lifecycle", () => {
  test("resolves on open", async () => {
    const sock = new FakeSocket()
    const conn = new CdpConnection({ url: "ws://x", socketFactory: () => sock })
    const p = conn.connect()
    sock.emit("open", undefined)
    await p
    expect(conn.connected).toBe(true)
  })

  test("rejects on error", async () => {
    const sock = new FakeSocket()
    const conn = new CdpConnection({ url: "ws://x", socketFactory: () => sock })
    const p = conn.connect()
    sock.emit("error", { message: "refused" })
    await expect(p).rejects.toThrow(/refused/)
  })

  test("close clears connected + caches and fires onClose", async () => {
    let closed = false
    const sock = new FakeSocket()
    const conn = new CdpConnection({
      url: "ws://x",
      socketFactory: () => sock,
      onClose: () => (closed = true),
    })
    const p = conn.connect()
    sock.emit("open", undefined)
    await p
    sock.push({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { url: "u", type: "page" } },
    })
    expect(conn.frameSessions.size).toBe(1)
    sock.close()
    expect(conn.connected).toBe(false)
    expect(conn.frameSessions.size).toBe(0)
    expect(closed).toBe(true)
  })
})

describe("send / reply correlation", () => {
  test("resolves the matching id", async () => {
    const { conn, sock } = connected()
    sock.autoReply = (f) => ({ id: f.id, result: { pong: true } })
    const r = await conn.send("Browser.getVersion")
    expect(r.result).toEqual({ pong: true })
    expect(sock.sent[0]?.method).toBe("Browser.getVersion")
  })

  test("rejects on error reply", async () => {
    const { conn, sock } = connected()
    sock.autoReply = (f) => ({ id: f.id, error: { code: -1, message: "nope" } })
    await expect(conn.send("Bad.method")).rejects.toThrow(/nope/)
  })

  test("times out when no reply arrives", async () => {
    const sock = new FakeSocket()
    const conn = new CdpConnection({
      url: "ws://x",
      socketFactory: () => sock,
      requestTimeoutMs: 10,
    })
    const p = conn.connect()
    sock.emit("open", undefined)
    await p
    await expect(conn.send("Never.replies")).rejects.toThrow(/timeout Never\.replies/)
  })

  test("send before connect rejects", async () => {
    const sock = new FakeSocket()
    const conn = new CdpConnection({ url: "ws://x", socketFactory: () => sock })
    await expect(conn.send("X")).rejects.toThrow(/not connected/)
  })

  test("unexpected close rejects every in-flight request at once", async () => {
    const sock = new FakeSocket()
    const conn = new CdpConnection({
      url: "ws://x",
      socketFactory: () => sock,
      requestTimeoutMs: 60_000, // long: prove we don't wait for the timer
    })
    const p = conn.connect()
    sock.emit("open", undefined)
    await p
    // Two sends with no reply, then the socket drops.
    const a = conn.send("Slow.one")
    const b = conn.send("Slow.two")
    sock.close()
    await expect(a).rejects.toThrow(/ws closed/)
    await expect(b).rejects.toThrow(/ws closed/)
  })

  test("a synchronous socket send() throw rejects that caller and leaves no pending", async () => {
    const sock = new FakeSocket()
    sock.send = () => {
      throw new Error("backpressure")
    }
    const conn = new CdpConnection({
      url: "ws://x",
      socketFactory: () => sock,
      requestTimeoutMs: 10,
    })
    const p = conn.connect()
    sock.emit("open", undefined)
    await p
    await expect(conn.send("Will.throw")).rejects.toThrow(/backpressure/)
    // No dangling timer: a later close has nothing to reject (no unhandled
    // rejection, no second settle).
    sock.close()
  })
})

describe("attach", () => {
  test("caches sessionId by targetId and enables auto-attach", async () => {
    const { conn, sock } = connected()
    sock.autoReply = (f) => {
      if (f.method === "Target.attachToTarget") return { id: f.id, result: { sessionId: "SESS" } }
      return { id: f.id, result: {} } // setAutoAttach
    }
    const s1 = await conn.attach("TARGET1")
    expect(s1).toBe("SESS")
    const sentMethods = sock.sent.map((f) => f.method)
    expect(sentMethods).toContain("Target.attachToTarget")
    expect(sentMethods).toContain("Target.setAutoAttach")

    // second attach is cached: no new attachToTarget frame
    const before = sock.sent.length
    const s2 = await conn.attach("TARGET1")
    expect(s2).toBe("SESS")
    expect(sock.sent.length).toBe(before)
  })
})

describe("findFrameSession", () => {
  test("returns the session whose url contains the substring", async () => {
    const { conn, sock } = connected()
    sock.push({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "SA",
        targetInfo: { url: "https://idmsa.apple.com/auth", type: "iframe" },
      },
    })
    sock.push({
      method: "Target.attachedToTarget",
      params: { sessionId: "SB", targetInfo: { url: "https://example.com", type: "iframe" } },
    })
    expect(conn.findFrameSession("idmsa")).toBe("SA")
    expect(conn.findFrameSession("example")).toBe("SB")
    expect(conn.findFrameSession("nope")).toBeUndefined()
  })
})

describe("download tracking", () => {
  test("begin then progress reflects in getDownloads", async () => {
    const { conn, sock } = connected()
    sock.push({
      method: "Browser.downloadWillBegin",
      params: { guid: "g1", url: "data:,x", suggestedFilename: "a.txt" },
    })
    sock.push({ method: "Browser.downloadProgress", params: { guid: "g1", state: "completed" } })
    const dl = conn.getDownloads()
    expect(dl).toEqual([{ guid: "g1", url: "data:,x", file: "a.txt", state: "completed" }])
  })
})
