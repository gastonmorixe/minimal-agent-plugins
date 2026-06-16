/**
 * Stateful CDP connection.
 *
 * Wraps a single browser-level WebSocket: correlates request ids to replies,
 * tracks attached target/frame sessions, and folds download events into a
 * records list. The WebSocket is injected via a factory so tests can supply a
 * fake duplex and drive the full request/reply + event path with no browser.
 *
 * @module lib/connection
 */

import { EventBuffer } from "./events.ts"
import {
  applyDownloadEvent,
  buildRequest,
  type CdpInbound,
  classifyInbound,
  type DownloadRecord,
} from "./protocol.ts"

/** The slice of the WHATWG WebSocket we depend on (so a fake satisfies it). */
export interface MinimalSocket {
  send(data: string): void
  close(): void
  addEventListener(type: "open", cb: () => void): void
  addEventListener(type: "close", cb: () => void): void
  addEventListener(type: "error", cb: (e: { message?: string }) => void): void
  addEventListener(type: "message", cb: (e: { data: string }) => void): void
}

export type SocketFactory = (url: string) => MinimalSocket

export interface ConnectionOpts {
  url: string
  socketFactory: SocketFactory
  /** Per-request timeout in ms (default 30_000). */
  requestTimeoutMs?: number
  /** Max events retained in the ring buffer (default 5000). */
  eventBufferCapacity?: number
  /** Called on unexpected close so the daemon can reconnect. */
  onClose?: () => void
  log?: (msg: string) => void
}

interface Pending {
  resolve: (m: CdpInbound) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One stateful connection to a browser's CDP WebSocket: sends requests with
 * correlated ids, tracks attached target/frame sessions, buffers inbound
 * events, and folds download lifecycle events into a records list.
 */
export class CdpConnection {
  private ws: MinimalSocket | null = null
  private idc = 0
  private readonly pending = new Map<number, Pending>()
  /** Maps sessionId to `{url,type}` for every attached target/frame. */
  readonly frameSessions = new Map<string, { url: string; type: string }>()
  /** Maps targetId to its cached page sessionId. */
  readonly targetSessions = new Map<string, string>()
  private downloads: DownloadRecord[] = []
  /** Bounded ring of every inbound CDP event (opt-in recording). */
  readonly events: EventBuffer
  private readonly opts: Required<Pick<ConnectionOpts, "requestTimeoutMs">> & ConnectionOpts

  constructor(opts: ConnectionOpts) {
    this.opts = { requestTimeoutMs: 30_000, ...opts }
    this.events = new EventBuffer(opts.eventBufferCapacity ?? 5000)
  }

  get connected(): boolean {
    return this.ws !== null
  }

  getDownloads(): DownloadRecord[] {
    return this.downloads
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.opts.socketFactory(this.opts.url)
      this.ws = ws
      ws.addEventListener("open", () => {
        this.opts.log?.(`connected ${this.opts.url}`)
        resolve()
      })
      ws.addEventListener("error", (e) => reject(new Error(e.message ?? "ws error")))
      ws.addEventListener("close", () => {
        this.opts.log?.("ws closed")
        this.ws = null
        this.targetSessions.clear()
        this.frameSessions.clear()
        // Reject every in-flight request now. Without this, a send() whose
        // reply will never arrive (the socket is gone) hangs until its own
        // 30s per-request timer fires, even though the daemon has already
        // started reconnecting on a fresh connection.
        this.rejectAllPending("ws closed")
        this.opts.onClose?.()
      })
      ws.addEventListener("message", (e) => this.onMessage(e.data))
    })
  }

  private onMessage(data: string): void {
    let m: CdpInbound
    try {
      m = JSON.parse(data) as CdpInbound
    } catch {
      return
    }
    // Any inbound frame that carries a `method` and no numeric `id` is an
    // async event push. Record it into the ring buffer (no-op unless recording
    // is on) BEFORE the special-case classification below, so generic event
    // inspection (`events` route) sees the full firehose, not just the few
    // events the daemon natively reacts to (attach/detach/downloads).
    if (typeof m.id !== "number" && typeof m.method === "string") {
      this.events.record(m.method, m.sessionId ?? "", m.params)
    }

    const c = classifyInbound(m)
    switch (c.kind) {
      case "reply": {
        const p = this.pending.get(c.id)
        if (!p) return
        this.pending.delete(c.id)
        clearTimeout(p.timer)
        if (c.error) p.reject(new Error(JSON.stringify(c.error)))
        else p.resolve(m)
        return
      }
      case "attached":
        this.frameSessions.set(c.sessionId, { url: c.url, type: c.targetType })
        return
      case "detached":
        this.frameSessions.delete(c.sessionId)
        return
      case "downloadBegin":
      case "downloadProgress":
        this.downloads = applyDownloadEvent(this.downloads, c)
        return
      default:
        return
    }
  }

  /** Send a CDP command and await its reply. Rejects on timeout or ws error. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpInbound> {
    if (!this.ws) return Promise.reject(new Error("not connected"))
    const id = ++this.idc
    const frame = buildRequest(id, method, params, sessionId)
    return new Promise<CdpInbound>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
        }
      }, this.opts.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // A synchronous throw from the socket (closing mid-send, backpressure)
      // must not strand the pending entry and its 30s timer. Tear them down
      // and surface the error to this caller.
      try {
        this.ws?.send(JSON.stringify(frame))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Reject and clear every in-flight request (called on unexpected close). */
  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /**
   * Attach to a page target (flattened) and turn on auto-attach so child
   * frames (out-of-process iframes) become reachable sessions. Caches the
   * page sessionId by targetId.
   */
  async attach(targetId: string): Promise<string> {
    const cached = this.targetSessions.get(targetId)
    if (cached) return cached
    const r = await this.send("Target.attachToTarget", { targetId, flatten: true })
    const sessionId = (r.result as { sessionId?: string })?.sessionId ?? ""
    this.targetSessions.set(targetId, sessionId)
    await this.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    ).catch(() => {})
    return sessionId
  }

  /**
   * Forget a target's cached page session. Call after closing a target so a
   * later re-create of the same targetId doesn't reuse a dead sessionId.
   */
  forgetTarget(targetId: string): void {
    this.targetSessions.delete(targetId)
  }

  /** Find an attached frame session whose URL contains `urlSub`. */
  findFrameSession(urlSub: string): string | undefined {
    for (const [sid, info] of this.frameSessions) {
      if (info.url.includes(urlSub)) return sid
    }
    return undefined
  }

  close(): void {
    this.ws?.close()
  }
}
