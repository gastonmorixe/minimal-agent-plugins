/**
 * Bounded ring buffer for CDP events (async server pushes).
 *
 * CDP commands are request/reply (correlated by `id`), but a huge part of the
 * protocol's value is in EVENTS: `Network.requestWillBeSent`,
 * `Network.responseReceived`, `Log.entryAdded`, `Runtime.consoleAPICalled`,
 * `Performance.metrics`, `Target.targetCreated`, and so on. Those arrive
 * unsolicited with no `id`, so a stateless request/reply passthrough can never
 * surface them. The daemon holds ONE long-lived socket, so it is the only thing
 * positioned to observe and retain them.
 *
 * This module is a pure, side-effect-free ring buffer: the connection records
 * every inbound event into it, and the `events` route drains it with optional
 * filtering. Keeping it pure means the retention/eviction/filter logic is
 * unit-tested without a browser or a socket.
 *
 * @module lib/events
 */

/** One recorded CDP event. */
export interface CdpEvent {
  /** Monotonic sequence number assigned on insert (drain cursor + ordering). */
  seq: number
  /** Wall-clock ms when recorded (Date.now()). */
  ts: number
  /** CDP method name, e.g. "Network.responseReceived". */
  method: string
  /** Originating session id (target/frame), or "" for browser-level events. */
  sessionId: string
  /** The event's `params` payload, as-is. */
  params: unknown
}

export interface EventQuery {
  /** Substring matched (case-insensitive) against the method name. */
  filter?: string
  /** Only return events with seq STRICTLY greater than this (drain cursor). */
  since?: number
  /** Only return events from this session id. */
  sessionId?: string
  /** Cap the number of returned events (most recent matching ones win). */
  limit?: number
}

export interface EventQueryResult {
  /** Matching events, in insertion order (oldest → newest). */
  events: CdpEvent[]
  /** Highest seq currently in the buffer (pass back as `since` to drain). */
  cursor: number
  /** Total events currently retained (post-eviction). */
  buffered: number
  /** Whether the buffer has evicted at least one event since reset. */
  dropped: number
}

/**
 * A fixed-capacity ring of recorded events. Oldest events are evicted once
 * `capacity` is exceeded; `seq` keeps climbing so a poller's `since` cursor
 * stays valid across evictions.
 */
export class EventBuffer {
  private readonly capacity: number
  private buf: CdpEvent[] = []
  private seqc = 0
  private droppedCount = 0
  /** Recording is opt-in: until a domain is enabled there's no reason to retain. */
  private recording = false

  constructor(capacity = 5000) {
    this.capacity = Math.max(1, capacity)
  }

  get isRecording(): boolean {
    return this.recording
  }

  setRecording(on: boolean): void {
    this.recording = on
  }

  /** Record one event. No-op when not recording. Returns the assigned seq, or -1. */
  record(method: string, sessionId: string, params: unknown): number {
    if (!this.recording) return -1
    const seq = ++this.seqc
    this.buf.push({ seq, ts: Date.now(), method, sessionId, params })
    if (this.buf.length > this.capacity) {
      const overflow = this.buf.length - this.capacity
      this.buf.splice(0, overflow)
      this.droppedCount += overflow
    }
    return seq
  }

  /** Query the buffer without mutating it. */
  query(q: EventQuery = {}): EventQueryResult {
    const f = q.filter?.toLowerCase()
    let out = this.buf
    if (q.since != null) out = out.filter((e) => e.seq > q.since!)
    if (q.sessionId) out = out.filter((e) => e.sessionId === q.sessionId)
    if (f) out = out.filter((e) => e.method.toLowerCase().includes(f))
    if (q.limit != null && q.limit >= 0 && out.length > q.limit) {
      out = out.slice(out.length - q.limit)
    }
    return {
      events: out,
      cursor: this.seqc,
      buffered: this.buf.length,
      dropped: this.droppedCount,
    }
  }

  /** Drop all retained events (keeps the seq counter climbing). */
  clear(): void {
    this.buf = []
  }

  /** A compact count of retained events grouped by method (for summaries). */
  countByMethod(): Record<string, number> {
    const m: Record<string, number> = {}
    for (const e of this.buf) m[e.method] = (m[e.method] ?? 0) + 1
    return m
  }
}
