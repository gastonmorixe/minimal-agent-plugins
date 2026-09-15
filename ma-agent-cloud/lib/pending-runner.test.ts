import { describe, expect, it } from "bun:test"

import type { ClaimResult, PendingGateway, PendingPrompt, PendingResult } from "./pending.ts"
import { PendingInjector } from "./pending-inject.ts"
import { PendingRunner, type SubscribeFn } from "./pending-runner.ts"
import type { Subscription } from "./pending-subscribe.ts"

/** A scriptable gateway: queue of pending lists (one per drain), all claims win. */
function scriptedGateway(lists: PendingPrompt[][]): { gw: PendingGateway; drains: number } {
  const state = { drains: 0 }
  const gw: PendingGateway = {
    async listPending(): Promise<PendingResult<PendingPrompt[]>> {
      const list = lists[state.drains] ?? []
      state.drains += 1
      return { ok: true, value: list }
    },
    async claim(pendingId): Promise<PendingResult<ClaimResult>> {
      return { ok: true, value: { claimed: true, pendingId, content: `content-${pendingId}` } }
    },
  }
  return {
    gw,
    get drains() {
      return state.drains
    },
  }
}

/** A fake subscribe that captures the callbacks so the test can fire `next`. */
function fakeSubscribe(): { fn: SubscribeFn; fireNext: () => void; unsubscribed: () => boolean } {
  let onNext: ((d: unknown) => void) | undefined
  let unsubbed = false
  const fn = ((opts: { onNext: (d: unknown) => void }) => {
    onNext = opts.onNext
    const sub: Subscription = {
      unsubscribe() {
        unsubbed = true
      },
    }
    return sub
  }) as unknown as SubscribeFn
  return {
    fn,
    fireNext: () => onNext?.({ pendingPromptAdded: { pendingId: "live" } }),
    unsubscribed: () => unsubbed,
  }
}

const p = (id: string): PendingPrompt => ({ pendingId: id, content: `content-${id}` })

describe("PendingRunner lifecycle", () => {
  it("start drains the backlog (claim+inject) and opens the subscription", async () => {
    const { gw } = scriptedGateway([[p("a"), p("b")]])
    const emitted: unknown[] = []
    const inj = new PendingInjector((_c, payload) => emitted.push(payload))
    const sub = fakeSubscribe()
    const runner = new PendingRunner({
      sid: "s1",
      wsUrl: "ws://x/graphql",
      bearer: "B",
      gateway: gw,
      injector: inj,
      subscribe: sub.fn,
    })
    await runner.start()
    // backlog a,b injected
    expect(emitted).toHaveLength(2)
    expect(runner.subscribed).toBe(true)
  })

  it("a live subscription next triggers a re-drain", async () => {
    // first drain (backlog) empty; second drain (after live signal) has one prompt
    const { gw } = scriptedGateway([[], [p("live1")]])
    const emitted: unknown[] = []
    const inj = new PendingInjector((_c, payload) => emitted.push(payload))
    const sub = fakeSubscribe()
    const runner = new PendingRunner({
      sid: "s1",
      wsUrl: "ws://x/graphql",
      bearer: "B",
      gateway: gw,
      injector: inj,
      subscribe: sub.fn,
    })
    await runner.start()
    expect(emitted).toHaveLength(0) // backlog empty
    sub.fireNext()
    await Promise.resolve() // let the async drain settle
    await Promise.resolve()
    expect(emitted).toHaveLength(1) // the live prompt got drained + injected
  })

  it("start is idempotent (no double subscribe)", async () => {
    const { gw } = scriptedGateway([[], []])
    const inj = new PendingInjector(() => {})
    const sub = fakeSubscribe()
    const runner = new PendingRunner({
      sid: "s1",
      wsUrl: "ws://x",
      bearer: "B",
      gateway: gw,
      injector: inj,
      subscribe: sub.fn,
    })
    await runner.start()
    await runner.start()
    expect(runner.subscribed).toBe(true)
  })

  it("stop unsubscribes", async () => {
    const { gw } = scriptedGateway([[]])
    const inj = new PendingInjector(() => {})
    const sub = fakeSubscribe()
    const runner = new PendingRunner({
      sid: "s1",
      wsUrl: "ws://x",
      bearer: "B",
      gateway: gw,
      injector: inj,
      subscribe: sub.fn,
    })
    await runner.start()
    runner.stop()
    expect(sub.unsubscribed()).toBe(true)
    expect(runner.subscribed).toBe(false)
  })

  it("a subscription error drops the sub (self-heal on next start)", async () => {
    const { gw } = scriptedGateway([[]])
    const inj = new PendingInjector(() => {})
    let onError: ((r: string) => void) | undefined
    const fn = ((opts: { onError: (r: string) => void }) => {
      onError = opts.onError
      return { unsubscribe() {} }
    }) as unknown as SubscribeFn
    const runner = new PendingRunner({
      sid: "s1",
      wsUrl: "ws://x",
      bearer: "B",
      gateway: gw,
      injector: inj,
      subscribe: fn,
    })
    await runner.start()
    expect(runner.subscribed).toBe(true)
    onError?.("socket closed")
    expect(runner.subscribed).toBe(false)
  })

  it("a failed drain is logged, never throws", async () => {
    const gw: PendingGateway = {
      async listPending() {
        return { ok: false, reason: "unauthorized" }
      },
      async claim() {
        return { ok: false, reason: "n/a" }
      },
    }
    const logs: string[] = []
    const inj = new PendingInjector(() => {})
    const sub = fakeSubscribe()
    const runner = new PendingRunner({
      sid: "s1",
      wsUrl: "ws://x",
      bearer: "B",
      gateway: gw,
      injector: inj,
      subscribe: sub.fn,
      log: (m) => logs.push(m),
    })
    await runner.start()
    expect(logs.some((l) => l.includes("unauthorized"))).toBe(true)
  })
})
