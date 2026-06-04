import { describe, expect, test } from "bun:test"

import { CdpConnection, type MinimalSocket } from "./connection.ts"
import { dispatch } from "./dispatch.ts"

/** Fake socket that answers requests via a method->result map. */
class ScriptedSocket implements MinimalSocket {
  sent: Array<Record<string, unknown>> = []
  private handlers: Record<string, Array<(e: unknown) => void>> = {}
  constructor(private readonly replies: Record<string, Record<string, unknown>>) {}
  send(data: string): void {
    const f = JSON.parse(data) as Record<string, unknown>
    this.sent.push(f)
    const result = this.replies[f.method as string] ?? {}
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: f.id, result }) }))
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
  push(msg: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(msg) })
  }
}

async function make(replies: Record<string, Record<string, unknown>>): Promise<{
  conn: CdpConnection
  sock: ScriptedSocket
}> {
  const sock = new ScriptedSocket(replies)
  const conn = new CdpConnection({ url: "ws://x", socketFactory: () => sock })
  const p = conn.connect()
  sock.emit("open", undefined)
  await p
  return { conn, sock }
}

describe("dispatch", () => {
  test("ping reports connection + ws url", async () => {
    const { conn } = await make({})
    const r = await dispatch(conn, "ping", {}, "ws://the-url")
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, connected: true, ws: "ws://the-url" })
  })

  test("targets filters to pages and slims fields", async () => {
    const { conn } = await make({
      "Target.getTargets": {
        targetInfos: [
          { targetId: "A", type: "page", title: "Tab A", url: "https://a" },
          { targetId: "B", type: "iframe", title: "frame", url: "https://b" },
        ],
      },
    })
    const r = await dispatch(conn, "targets", {}, "ws://x")
    expect(r.body).toEqual([{ id: "A", title: "Tab A", url: "https://a" }])
  })

  test("alltargets keeps every type", async () => {
    const { conn } = await make({
      "Target.getTargets": {
        targetInfos: [
          { targetId: "A", type: "page", url: "https://a" },
          { targetId: "B", type: "iframe", url: "https://b" },
        ],
      },
    })
    const r = await dispatch(conn, "alltargets", {}, "ws://x")
    expect(r.body).toEqual([
      { type: "page", id: "A", url: "https://a" },
      { type: "iframe", id: "B", url: "https://b" },
    ])
  })

  test("eval attaches and returns the evaluated value", async () => {
    const { conn, sock } = await make({
      "Target.attachToTarget": { sessionId: "S1" },
      "Target.setAutoAttach": {},
      "Runtime.evaluate": { result: { value: 42 } },
    })
    const r = await dispatch(conn, "eval", { target: "A", expr: "21*2" }, "ws://x")
    expect(r.body).toEqual({ result: 42 })
    expect(sock.sent.some((f) => f.method === "Runtime.evaluate")).toBe(true)
  })

  test("eval surfaces a page exception as __error", async () => {
    const { conn } = await make({
      "Target.attachToTarget": { sessionId: "S1" },
      "Target.setAutoAttach": {},
      "Runtime.evaluate": { exceptionDetails: { exception: { description: "Error: boom" } } },
    })
    const r = await dispatch(conn, "eval", { target: "A", expr: "throw 1" }, "ws://x")
    expect(r.body).toEqual({ result: { __error: "Error: boom" } })
  })

  test("frameeval returns __error + seen frames when no match", async () => {
    const { conn } = await make({
      "Target.attachToTarget": { sessionId: "S1" },
      "Target.setAutoAttach": {},
    })
    const r = await dispatch(
      conn,
      "frameeval",
      { target: "A", urlSub: "idmsa", expr: "1" },
      "ws://x",
      {
        frameSettleMs: 0,
      },
    )
    expect(r.body).toEqual({ result: { __error: "frame not found", frames: [] } })
  })

  test("frameeval evals in the matching child frame", async () => {
    const { conn, sock } = await make({
      "Target.attachToTarget": { sessionId: "PAGE" },
      "Target.setAutoAttach": {},
      "Runtime.evaluate": { result: { value: "in-frame" } },
    })
    sock.push({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "FRAME",
        targetInfo: { url: "https://idmsa.apple.com/x", type: "iframe" },
      },
    })
    const r = await dispatch(
      conn,
      "frameeval",
      { target: "A", urlSub: "idmsa", expr: "location.href" },
      "ws://x",
      {
        frameSettleMs: 0,
      },
    )
    expect(r.body).toEqual({ result: "in-frame" })
    const evalFrame = sock.sent.find((f) => f.method === "Runtime.evaluate")
    expect(evalFrame?.sessionId).toBe("FRAME")
  })

  test("newtab returns the new target id", async () => {
    const { conn } = await make({ "Target.createTarget": { targetId: "NEW" } })
    const r = await dispatch(conn, "newtab", { url: "https://x" }, "ws://x")
    expect(r.body).toEqual({ id: "NEW" })
  })

  test("nav enables the page and navigates", async () => {
    const { conn, sock } = await make({
      "Target.attachToTarget": { sessionId: "S1" },
      "Target.setAutoAttach": {},
      "Page.enable": {},
      "Page.navigate": {},
    })
    const r = await dispatch(conn, "nav", { target: "A", url: "https://dest" }, "ws://x")
    expect(r.body).toEqual({ ok: true })
    const navFrame = sock.sent.find((f) => f.method === "Page.navigate")
    const navParams = navFrame?.params as { url: string } | undefined
    expect(navParams?.url).toBe("https://dest")
  })

  test("setdownload sets both browser and page scopes", async () => {
    const { conn, sock } = await make({
      "Target.attachToTarget": { sessionId: "S1" },
      "Target.setAutoAttach": {},
      "Browser.setDownloadBehavior": {},
      "Page.setDownloadBehavior": {},
    })
    const r = await dispatch(conn, "setdownload", { target: "A", dir: "/tmp/dl" }, "ws://x")
    expect(r.body).toEqual({ ok: true, dir: "/tmp/dl" })
    const methods = sock.sent.map((f) => f.method)
    expect(methods).toContain("Browser.setDownloadBehavior")
    expect(methods).toContain("Page.setDownloadBehavior")
  })

  test("downloads returns tracked records", async () => {
    const { conn, sock } = await make({})
    sock.push({
      method: "Browser.downloadWillBegin",
      params: { guid: "g", url: "u", suggestedFilename: "f.txt" },
    })
    sock.push({ method: "Browser.downloadProgress", params: { guid: "g", state: "completed" } })
    const r = await dispatch(conn, "downloads", {}, "ws://x")
    expect(r.body).toEqual([{ guid: "g", url: "u", file: "f.txt", state: "completed" }])
  })

  test("send forwards an arbitrary browser-global method", async () => {
    const { conn, sock } = await make({
      "Performance.getMetrics": { metrics: [{ name: "x", value: 1 }] },
    })
    const r = await dispatch(
      conn,
      "send",
      { method: "Performance.getMetrics", params: {} },
      "ws://x",
    )
    expect(r.body).toEqual({ result: { metrics: [{ name: "x", value: 1 }] }, sessionId: null })
    expect(sock.sent.some((f) => f.method === "Performance.getMetrics")).toBe(true)
  })

  test("send attaches when a target is given and scopes the call", async () => {
    const { conn, sock } = await make({
      "Target.attachToTarget": { sessionId: "S9" },
      "Target.setAutoAttach": {},
      "DOM.getDocument": { root: { nodeId: 1 } },
    })
    const r = await dispatch(
      conn,
      "send",
      { method: "DOM.getDocument", params: { depth: 1 }, target: "A" },
      "ws://x",
    )
    expect(r.body).toEqual({ result: { root: { nodeId: 1 } }, sessionId: "S9" })
    const f = sock.sent.find((x) => x.method === "DOM.getDocument")
    expect(f?.sessionId).toBe("S9")
  })

  test("send auto-enables event recording on a *.enable", async () => {
    const { conn } = await make({ "Network.enable": {} })
    expect(conn.events.isRecording).toBe(false)
    await dispatch(conn, "send", { method: "Network.enable", params: {} }, "ws://x")
    expect(conn.events.isRecording).toBe(true)
  })

  test("send shapes a protocol error as __error instead of throwing", async () => {
    const { conn, sock } = await make({})
    // Make the socket answer with an error frame for this method.
    const orig = sock.send.bind(sock)
    sock.send = (data: string) => {
      const f = JSON.parse(data) as Record<string, unknown>
      if (f.method === "Bogus.method") {
        queueMicrotask(() =>
          sock.emit("message", {
            data: JSON.stringify({ id: f.id, error: { code: -32000, message: "no such method" } }),
          }),
        )
        return
      }
      orig(data)
    }
    const r = await dispatch(conn, "send", { method: "Bogus.method", params: {} }, "ws://x")
    const body = r.body as { result: { __error?: string } }
    expect(body.result.__error).toContain("no such method")
  })

  test("events drains buffered events recorded from the firehose", async () => {
    const { conn, sock } = await make({})
    conn.events.setRecording(true)
    sock.push({ method: "Network.requestWillBeSent", params: { requestId: "1" }, sessionId: "S" })
    sock.push({ method: "Network.responseReceived", params: { requestId: "1" }, sessionId: "S" })
    const r = await dispatch(conn, "events", { filter: "Network" }, "ws://x")
    const body = r.body as { count: number; recording: boolean; events: Array<{ method: string }> }
    expect(body.recording).toBe(true)
    expect(body.count).toBe(2)
    expect(body.events.map((e) => e.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
    ])
  })

  test("events clear empties the buffer after returning", async () => {
    const { conn, sock } = await make({})
    conn.events.setRecording(true)
    sock.push({ method: "Log.entryAdded", params: {}, sessionId: "" })
    const r1 = await dispatch(conn, "events", { clear: true }, "ws://x")
    expect((r1.body as { count: number }).count).toBe(1)
    const r2 = await dispatch(conn, "events", {}, "ws://x")
    expect((r2.body as { count: number }).count).toBe(0)
  })

  test("record toggles recording", async () => {
    const { conn } = await make({})
    const on = await dispatch(conn, "record", { on: true }, "ws://x")
    expect((on.body as { recording: boolean }).recording).toBe(true)
    const off = await dispatch(conn, "record", { on: false }, "ws://x")
    expect((off.body as { recording: boolean }).recording).toBe(false)
  })

  test("closetarget closes and forgets the cached session", async () => {
    const { conn, sock } = await make({
      "Target.attachToTarget": { sessionId: "S1" },
      "Target.setAutoAttach": {},
      "Target.closeTarget": { success: true },
    })
    await conn.attach("A")
    expect(conn.targetSessions.has("A")).toBe(true)
    const r = await dispatch(conn, "closetarget", { target: "A" }, "ws://x")
    expect(r.body).toEqual({ ok: true, target: "A" })
    expect(conn.targetSessions.has("A")).toBe(false)
    expect(sock.sent.some((f) => f.method === "Target.closeTarget")).toBe(true)
  })

  test("activatetarget focuses a tab", async () => {
    const { conn, sock } = await make({ "Target.activateTarget": {} })
    const r = await dispatch(conn, "activatetarget", { target: "A" }, "ws://x")
    expect(r.body).toEqual({ ok: true, target: "A" })
    expect(sock.sent.some((f) => f.method === "Target.activateTarget")).toBe(true)
  })

  test("getinfo returns the TargetInfo payload", async () => {
    const { conn } = await make({
      "Target.getTargetInfo": { targetInfo: { targetId: "A", type: "page", url: "https://a" } },
    })
    const r = await dispatch(conn, "getinfo", { target: "A" }, "ws://x")
    expect(r.body).toEqual({ targetId: "A", type: "page", url: "https://a" })
  })
})
