import { describe, expect, it } from "bun:test"

import {
  type ClaimedPrompt,
  type ClaimResult,
  drainAndClaim,
  type PendingGateway,
  type PendingPrompt,
  type PendingResult,
} from "./pending.ts"

/** A fake gateway scripted with pending prompts + per-id claim outcomes. */
function fakeGateway(
  pending: PendingPrompt[],
  claimOutcomes: Record<string, ClaimResult | "throw">,
): { gw: PendingGateway; claimCalls: string[] } {
  const claimCalls: string[] = []
  const gw: PendingGateway = {
    async listPending(): Promise<PendingResult<PendingPrompt[]>> {
      return { ok: true, value: pending }
    },
    async claim(pendingId): Promise<PendingResult<ClaimResult>> {
      claimCalls.push(pendingId)
      const o = claimOutcomes[pendingId]
      if (o === "throw") return { ok: false, reason: "network" }
      if (!o) return { ok: false, reason: "unknown id" }
      return { ok: true, value: o }
    },
  }
  return { gw, claimCalls }
}

const p = (id: string, content: unknown): PendingPrompt => ({ pendingId: id, content })

describe("drainAndClaim", () => {
  it("claims + injects the prompts WE win, skips the ones another CLI won", async () => {
    const { gw } = fakeGateway([p("a", "run A"), p("b", "run B"), p("c", "run C")], {
      a: { claimed: true, pendingId: "a", content: "run A" },
      b: { claimed: false, pendingId: "b", reason: "already-claimed" }, // another CLI won
      c: { claimed: true, pendingId: "c", content: "run C" },
    })
    const injected: ClaimedPrompt[] = []
    const res = await drainAndClaim("sid-1", gw, (cp) => injected.push(cp))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.map((x) => x.pendingId)).toEqual(["a", "c"])
    expect(injected.map((x) => x.pendingId)).toEqual(["a", "c"]) // b skipped (lock lost)
    expect(injected.map((x) => x.content)).toEqual(["run A", "run C"])
  })

  it("threads pendingId onto each claimed prompt (Tom's reconciliation key)", async () => {
    const { gw } = fakeGateway([p("x", "hi")], {
      x: { claimed: true, pendingId: "x", content: "hi" },
    })
    const injected: ClaimedPrompt[] = []
    await drainAndClaim("sid-1", gw, (cp) => injected.push(cp))
    expect(injected[0]).toEqual({ pendingId: "x", content: "hi" })
  })

  it("a transient claim failure doesn't abort the batch — later prompts still claim", async () => {
    const { gw, claimCalls } = fakeGateway([p("a", "A"), p("b", "B")], {
      a: "throw",
      b: { claimed: true, pendingId: "b", content: "B" },
    })
    const injected: ClaimedPrompt[] = []
    const res = await drainAndClaim("sid-1", gw, (cp) => injected.push(cp))
    expect(res.ok).toBe(true)
    expect(claimCalls).toEqual(["a", "b"]) // both attempted
    expect(injected.map((x) => x.pendingId)).toEqual(["b"]) // a left pending, b ran
  })

  it("a failed listPending surfaces as ok:false (never throws)", async () => {
    const gw: PendingGateway = {
      async listPending() {
        return { ok: false, reason: "unauthorized" }
      },
      async claim() {
        return { ok: false, reason: "n/a" }
      },
    }
    const res = await drainAndClaim("sid-1", gw, () => {})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("unauthorized")
  })

  it("an injector that throws doesn't crash the drain", async () => {
    const { gw } = fakeGateway([p("a", "A")], {
      a: { claimed: true, pendingId: "a", content: "A" },
    })
    const res = await drainAndClaim("sid-1", gw, () => {
      throw new Error("bus down")
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual([]) // claimed server-side but injection failed
  })

  it("empty pending list ⇒ nothing claimed", async () => {
    const { gw } = fakeGateway([], {})
    const res = await drainAndClaim("sid-1", gw, () => {})
    expect(res.ok && res.value).toEqual([])
  })
})
