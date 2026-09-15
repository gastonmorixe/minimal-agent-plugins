import { describe, expect, it } from "bun:test"

import {
  PENDING_ADDED_SUBSCRIPTION,
  subscribePendingPrompts,
  type WebSocketLike,
} from "./pending-subscribe.ts"

/** A fake WebSocket that records sent frames + lets the test drive server events. */
class FakeSocket implements WebSocketLike {
  sent: unknown[] = []
  closed = false
  private handlers: Record<string, ((ev: unknown) => void)[]> = {}

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
    this.fire("close", {})
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    ;(this.handlers[type] ??= []).push(cb)
  }
  /** Test drivers. */
  fire(type: string, ev: unknown): void {
    for (const cb of this.handlers[type] ?? []) cb(ev)
  }
  serverSend(msg: unknown): void {
    this.fire("message", { data: JSON.stringify(msg) })
  }
  /** The last frame the client sent, by type. */
  lastOfType(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => (m as { type?: string }).type === type) as
      | Record<string, unknown>
      | undefined
  }
}

function setup() {
  const sock = new FakeSocket()
  const next: unknown[] = []
  const errors: string[] = []
  let completed = false
  const sub = subscribePendingPrompts<{ pendingPromptAdded: { pendingId: string } }>({
    url: "ws://localhost:4000/graphql",
    bearer: "BEARER-XYZ",
    query: PENDING_ADDED_SUBSCRIPTION,
    variables: { sid: "s1" },
    onNext: (d) => next.push(d),
    onError: (r) => errors.push(r),
    onComplete: () => {
      completed = true
    },
    makeSocket: () => sock,
  })
  return { sock, next, errors, sub, completed: () => completed }
}

describe("subscribePendingPrompts — graphql-transport-ws protocol", () => {
  it("does the init→ack→subscribe handshake with the Bearer", () => {
    const { sock } = setup()
    sock.fire("open", {})
    const initPayload = sock.lastOfType("connection_init")?.payload as
      | { authorization: string }
      | undefined
    expect(initPayload?.authorization).toBe("Bearer BEARER-XYZ")
    // server acks → client subscribes
    sock.serverSend({ type: "connection_ack" })
    const subPayload = sock.lastOfType("subscribe")?.payload as
      | { variables: { sid: string }; query: string }
      | undefined
    expect(subPayload).toBeDefined()
    expect(subPayload?.variables.sid).toBe("s1")
    expect(subPayload?.query).toContain("pendingPromptAdded")
  })

  it("delivers next payloads' data to onNext, matched by subscription id", () => {
    const { sock, next } = setup()
    sock.fire("open", {})
    sock.serverSend({ type: "connection_ack" })
    const id = (sock.lastOfType("subscribe") as { id: string }).id
    sock.serverSend({
      type: "next",
      id,
      payload: { data: { pendingPromptAdded: { pendingId: "P1" } } },
    })
    sock.serverSend({
      type: "next",
      id: "other",
      payload: { data: { pendingPromptAdded: { pendingId: "X" } } },
    })
    expect(next).toHaveLength(1) // the mismatched id is ignored
    expect(
      (next[0] as { pendingPromptAdded: { pendingId: string } }).pendingPromptAdded.pendingId,
    ).toBe("P1")
  })

  it("responds to ping with pong (keepalive)", () => {
    const { sock } = setup()
    sock.fire("open", {})
    sock.serverSend({ type: "ping" })
    expect(sock.lastOfType("pong")).toBeDefined()
  })

  it("routes a GraphQL error to onError", () => {
    const { sock, errors } = setup()
    sock.fire("open", {})
    sock.serverSend({ type: "connection_ack" })
    const id = (sock.lastOfType("subscribe") as { id: string }).id
    sock.serverSend({ type: "error", id, payload: [{ message: "unauthorized" }] })
    expect(errors[0]).toContain("unauthorized")
  })

  it("a close BEFORE ack surfaces as a connection error", () => {
    const { sock, errors } = setup()
    sock.fire("open", {})
    sock.fire("close", {})
    expect(errors.some((e) => e.includes("before connection_ack"))).toBe(true)
  })

  it("unsubscribe sends complete + closes", () => {
    const { sock, sub } = setup()
    sock.fire("open", {})
    sock.serverSend({ type: "connection_ack" })
    sub.unsubscribe()
    expect(sock.lastOfType("complete")).toBeDefined()
    expect(sock.closed).toBe(true)
  })

  it("server complete fires onComplete", () => {
    const { sock, completed } = setup()
    sock.fire("open", {})
    sock.serverSend({ type: "connection_ack" })
    const id = (sock.lastOfType("subscribe") as { id: string }).id
    sock.serverSend({ type: "complete", id })
    expect(completed()).toBe(true)
  })
})
