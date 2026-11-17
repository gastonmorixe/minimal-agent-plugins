/**
 * Tests for the scheduler functional core.
 *
 * @module schedule/lib/scheduler.test
 */

import { describe, expect, it } from "bun:test"

import { due, jitterSecondsFor, nextFireMs, pruneOnLoad } from "./scheduler.ts"
import type { CronEntry } from "./store.ts"

function entry(over: Partial<CronEntry> & Pick<CronEntry, "id">): CronEntry {
  return {
    id: over.id,
    cron: over.cron ?? "*/5 * * * *",
    prompt: over.prompt ?? "do the thing",
    recurs: over.recurs ?? true,
    pace: over.pace ?? "fixed",
    createdAt: over.createdAt ?? 0,
    ...(over.lastFiredAt !== undefined ? { lastFiredAt: over.lastFiredAt } : {}),
    ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : {}),
    ...(over.nextAtMs !== undefined ? { nextAtMs: over.nextAtMs } : {}),
    ...(over.intervalMs !== undefined ? { intervalMs: over.intervalMs } : {}),
  }
}

function ms(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, 0).getTime()
}

describe("due — fixed recurring", () => {
  it("fires on a matching minute and dedupes within the minute", () => {
    const e = entry({ id: "aaaa1111", cron: "*/5 * * * *" })
    const t0 = ms(2026, 5, 30, 10, 0, 5)
    const r1 = due([e], t0)
    expect(r1.fire.map((x) => x.id)).toEqual(["aaaa1111"])
    expect(r1.mutated?.[0]?.lastFiredAt).toBe(t0)

    // Same minute, a few seconds later, using the mutated entry → no re-fire.
    const e2 = r1.mutated?.[0] as CronEntry
    const r2 = due([e2], ms(2026, 5, 30, 10, 0, 40))
    expect(r2.fire).toEqual([])
    expect(r2.mutated).toBeNull()
  })

  it("fires again on the next matching minute", () => {
    const e = entry({
      id: "aaaa1111",
      cron: "*/5 * * * *",
      lastFiredAt: ms(2026, 5, 30, 10, 0, 5),
    })
    const r = due([e], ms(2026, 5, 30, 10, 5, 1))
    expect(r.fire.map((x) => x.id)).toEqual(["aaaa1111"])
  })

  it("does not fire on a non-matching minute", () => {
    const e = entry({ id: "aaaa1111", cron: "*/5 * * * *" })
    const r = due([e], ms(2026, 5, 30, 10, 3, 0))
    expect(r.fire).toEqual([])
    expect(r.mutated).toBeNull()
  })

  it("keeps but never fires a malformed cron", () => {
    const e = entry({ id: "bbbb2222", cron: "not a cron" })
    const r = due([e], ms(2026, 5, 30, 10, 0, 0))
    expect(r.fire).toEqual([])
    expect(r.mutated).toBeNull()
  })
})

describe("due — jitter gating", () => {
  it("delays firing until now.seconds >= jitter(id)", () => {
    const e = entry({ id: "jit", cron: "* * * * *" })
    const jitterSeconds = () => 20
    // second 10 < 20 → no fire
    expect(due([e], ms(2026, 5, 30, 10, 0, 10), { jitterSeconds }).fire).toEqual([])
    // second 25 >= 20 → fire
    expect(due([e], ms(2026, 5, 30, 10, 0, 25), { jitterSeconds }).fire.map((x) => x.id)).toEqual([
      "jit",
    ])
  })
})

describe("due — one-shot", () => {
  it("fires once when now >= nextAtMs then deletes itself", () => {
    const target = ms(2026, 5, 30, 15, 0, 0)
    const e = entry({ id: "once0001", recurs: false, nextAtMs: target, cron: "0 15 * * *" })
    const before = due([e], target - 1000)
    expect(before.fire).toEqual([])

    const at = due([e], target + 500)
    expect(at.fire.map((x) => x.id)).toEqual(["once0001"])
    // one-shot removed from the persisted set
    expect(at.mutated).toEqual([])
  })
})

describe("due — dynamic", () => {
  it("a self-paced task (no intervalMs) fires at nextAtMs and re-arms by defaultDynamicMs", () => {
    const target = ms(2026, 5, 30, 12, 0, 0)
    const e = entry({ id: "dyn00001", pace: "dynamic", recurs: true, nextAtMs: target })
    const now = target + 100
    const r = due([e], now, { defaultDynamicMs: 60_000 })
    expect(r.fire.map((x) => x.id)).toEqual(["dyn00001"])
    expect(r.mutated?.[0]?.nextAtMs).toBe(now + 60_000)
    expect(r.mutated?.[0]?.lastFiredAt).toBe(now)
  })

  it("a self-paced task with no options re-arms by the 5-minute built-in default", () => {
    const target = ms(2026, 5, 30, 12, 0, 0)
    const e = entry({ id: "dyn00002", pace: "dynamic", recurs: true, nextAtMs: target })
    const r = due([e], target)
    expect(r.mutated?.[0]?.nextAtMs).toBe(target + 5 * 60_000)
  })

  it("a task with intervalMs re-arms by its own interval, not the default", () => {
    const target = ms(2026, 5, 30, 12, 0, 0)
    const e = entry({
      id: "dyn00003",
      pace: "dynamic",
      recurs: true,
      nextAtMs: target,
      intervalMs: 30_000,
    })
    const r = due([e], target + 100, { defaultDynamicMs: 60_000 })
    expect(r.fire.map((x) => x.id)).toEqual(["dyn00003"])
    expect(r.mutated?.[0]?.nextAtMs).toBe(target + 100 + 30_000)
  })

  it("a 30s interval re-arms at 30s across 3 fires", () => {
    let e = entry({
      id: "dyn00004",
      pace: "dynamic",
      recurs: true,
      nextAtMs: ms(2026, 5, 30, 12, 0, 0),
      intervalMs: 30_000,
    })
    const fires: number[] = []
    // Tick once a second for two minutes, like the 1-second heartbeat.
    for (let t = e.nextAtMs as number; fires.length < 3; t += 1000) {
      const r = due([e], t)
      if (r.fire.length > 0) fires.push(t)
      if (r.mutated) e = r.mutated[0] as CronEntry
    }
    const start = ms(2026, 5, 30, 12, 0, 0)
    expect(fires).toEqual([start, start + 30_000, start + 60_000])
    expect(e.nextAtMs).toBe(start + 90_000)
  })
})

describe("due — fixed recurring with a nextAtMs override", () => {
  it("holds the cron until nextAtMs, fires once, then resumes the cron", () => {
    // */5 cron; override to 10:07:00, between two cron minutes.
    let e = entry({ id: "ovr00001", cron: "*/5 * * * *", nextAtMs: ms(2026, 5, 30, 10, 7, 0) })

    // 10:05 matches the cron but comes before the override → no fire.
    const early = due([e], ms(2026, 5, 30, 10, 5, 0))
    expect(early.fire).toEqual([])

    // 10:07 → the single-use override fires and is cleared.
    const at = due([e], ms(2026, 5, 30, 10, 7, 0))
    expect(at.fire.map((x) => x.id)).toEqual(["ovr00001"])
    e = at.mutated?.[0] as CronEntry
    expect(e.nextAtMs).toBeUndefined()
    expect(e.pace).toBe("fixed")
    expect(nextFireMs(e, ms(2026, 5, 30, 10, 7, 1))).toBe(ms(2026, 5, 30, 10, 10, 0))

    // 10:08 does not match the cron → nothing; 10:10 does → the cron fires.
    expect(due([e], ms(2026, 5, 30, 10, 8, 0)).fire).toEqual([])
    expect(due([e], ms(2026, 5, 30, 10, 10, 0)).fire.map((x) => x.id)).toEqual(["ovr00001"])
  })

  it("does not double-fire when the override lands on a cron minute", () => {
    const e = entry({ id: "ovr00002", cron: "*/5 * * * *", nextAtMs: ms(2026, 5, 30, 10, 10, 0) })
    const at = due([e], ms(2026, 5, 30, 10, 10, 0))
    expect(at.fire.length).toBe(1)
    const again = due([at.mutated?.[0] as CronEntry], ms(2026, 5, 30, 10, 10, 30))
    expect(again.fire).toEqual([])
  })
})

describe("due — expiry", () => {
  it("drops a recurring task past its expiresAt without firing", () => {
    const e = entry({ id: "exp00001", cron: "* * * * *", expiresAt: ms(2026, 5, 30, 10, 0, 0) })
    const r = due([e], ms(2026, 5, 30, 10, 1, 0))
    expect(r.fire).toEqual([])
    expect(r.mutated).toEqual([]) // dropped
  })
})

describe("pruneOnLoad", () => {
  it("drops expired recurring + missed one-shots, keeps the rest", () => {
    const now = ms(2026, 5, 30, 12, 0, 0)
    const liveRecurring = entry({ id: "live0001", expiresAt: now + 86_400_000 })
    const deadRecurring = entry({ id: "dead0001", expiresAt: now - 1000 })
    const missedOnce = entry({ id: "miss0001", recurs: false, nextAtMs: now - 5000 })
    const futureOnce = entry({ id: "soon0001", recurs: false, nextAtMs: now + 5000 })
    const { kept, dropped } = pruneOnLoad(
      [liveRecurring, deadRecurring, missedOnce, futureOnce],
      now,
    )
    expect(kept.map((e) => e.id).sort()).toEqual(["live0001", "soon0001"])
    expect(dropped.map((e) => e.id).sort()).toEqual(["dead0001", "miss0001"])
  })
})

describe("jitterSecondsFor", () => {
  it("is deterministic and in [0,30)", () => {
    for (const id of ["abcd1234", "ffff0000", "a1b2c3d4", "00000000"]) {
      const j = jitterSecondsFor(id)
      expect(j).toBe(jitterSecondsFor(id))
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(30)
    }
  })
})

describe("nextFireMs", () => {
  it("uses cron for fixed recurring", () => {
    const e = entry({ id: "x", cron: "0 9 * * *" })
    const now = ms(2026, 5, 30, 10, 0, 0)
    expect(nextFireMs(e, now)).toBe(ms(2026, 5, 31, 9, 0, 0))
  })

  it("uses nextAtMs for time-based tasks", () => {
    const target = ms(2026, 5, 30, 15, 0, 0)
    const e = entry({ id: "x", recurs: false, nextAtMs: target })
    expect(nextFireMs(e, target - 1000)).toBe(target)
    expect(nextFireMs(e, target + 1000)).toBeNull() // already past
  })
})
