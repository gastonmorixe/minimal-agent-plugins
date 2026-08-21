import { describe, expect, it } from "bun:test"

import { renderTpsTail } from "./render.ts"
import { TpsTracker } from "./tps-tracker.ts"

describe("TpsTracker (delta-driven sliding window)", () => {
  it("reports inactive before any deltas", () => {
    const t = new TpsTracker()
    expect(t.read(0)).toEqual({ tps: 0, active: false })
  })

  it("computes live rate once the window has span", () => {
    const t = new TpsTracker()
    // ~50 tok/s: batches of 25 tokens every 500ms.
    t.sample(0, 25)
    t.sample(500, 25)
    t.sample(1000, 25)
    t.sample(1500, 25)
    // Window at t=2000: span 2s, sum excluding oldest = 4×25 = 100.
    const r = t.sample(2000, 25)
    expect(r.active).toBe(true)
    expect(r.tps).toBe(50) // 100/2
  })

  it("tracks a DECELERATING stream downward (live, not frozen)", () => {
    const t = new TpsTracker({ windowMs: 10_000 })
    // Fast burst first: 400 tok/s for 1s.
    t.sample(0, 100)
    t.sample(250, 100)
    t.sample(500, 100)
    t.sample(750, 100)
    t.sample(1000, 100)
    // Then the stream slows to ~40 tok/s. By t=15_000 the fast burst has
    // fallen out of the 10s window entirely and the rate reflects only the
    // slow tail.
    let tMs = 1250
    while (tMs < 15_000) {
      t.sample(tMs, 10)
      tMs += 250
    }
    const r = t.sample(tMs, 10)
    // Window now spans only slow samples → ~40 tok/s.
    expect(r.tps).toBeLessThan(55)
    expect(r.tps).toBeGreaterThan(25)
  })

  it("holds display when the window span is under minSpanMs", () => {
    const t = new TpsTracker({ minSpanMs: 1000 })
    t.sample(0, 50)
    // Only 300ms of span: too little signal — hold previous display (0).
    t.sample(300, 50)
    expect(t.read(300).tps).toBe(0)
    // After enough span, a real number appears.
    t.sample(1100, 50)
    expect(t.read(1100).tps).toBeGreaterThan(0)
  })

  it("goes idle after idleMs without any deltas", () => {
    const t = new TpsTracker({ idleMs: 15_000 })
    t.sample(0, 50)
    t.sample(500, 50)
    expect(t.read(14_000).active).toBe(true)
    expect(t.read(16_000).active).toBe(false)
  })

  it("ignores out-of-order samples", () => {
    const t = new TpsTracker()
    t.sample(0, 50)
    t.sample(500, 50)
    t.sample(1000, 50)
    // Backwards timestamp: ignored as noise, reading unchanged.
    const r = t.sample(600, 50)
    expect(r.active).toBe(true)
  })

  it("ignores non-finite or non-positive deltas", () => {
    const t = new TpsTracker()
    t.sample(0, 50)
    expect(t.sample(500, Number.NaN).active).toBe(true)
    expect(t.sample(600, 0).active).toBe(true)
    expect(t.sample(700, -5).active).toBe(true)
  })

  it("reset clears all state", () => {
    const t = new TpsTracker()
    t.sample(0, 50)
    t.sample(500, 50)
    t.reset()
    expect(t.read(1000)).toEqual({ tps: 0, active: false })
  })

  it("completeness: N rapid sub-250ms batches all contribute to window total (regression for coalesce event loss)", () => {
    // Simulate the host streaming N batches at sub-BATCH_MS spacing (sub-250ms)
    // — exactly the cadence that coalesce:true collapsed to "latest only" and
    // left the footer blank. With coalesce removed every batch must reach the
    // tracker and sum into the window.
    const t = new TpsTracker({ windowMs: 10_000, minSpanMs: 10 })
    const N = 20
    const delta = 10
    // 20ms spacing — well under BATCH_MS (250ms).
    for (let i = 0; i < N; i++) t.sample(i * 20, delta)
    const r = t.read(N * 20)
    // Window span = 380ms (0..380), total excluding oldest = 19*10 = 190.
    // tps = 190 / 0.38 = 500. If any intermediate batch were dropped the
    // rate would collapse (e.g. latest-only would be ~26).
    expect(r.active).toBe(true)
    expect(r.tps).toBe(500)
  })
})

describe("renderTpsTail", () => {
  it("renders faint N/tps when active", () => {
    expect(renderTpsTail(42, true)).toBe("\x1b[2m42/tps\x1b[22m")
  })

  it("renders empty when inactive or zero", () => {
    expect(renderTpsTail(42, false)).toBe("")
    expect(renderTpsTail(0, true)).toBe("")
    expect(renderTpsTail(0, false)).toBe("")
  })
})
