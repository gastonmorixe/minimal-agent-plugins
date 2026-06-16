import { describe, expect, it } from "bun:test"

import type { Thresholds } from "./config.ts"
import { classifyLiveness, isReachable, LIVENESS_RANK, livenessLabel } from "./liveness.ts"
import type { PresenceRecord } from "./presence.ts"

const TH: Thresholds = { heartbeatMs: 5_000, freshMs: 20_000, staleMs: 90_000 }
const HOST = "macbook.local"
const NOW = Date.parse("2026-06-13T12:00:00.000Z")

function rec(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    v: 1,
    sid: "aaaaaaaa-1111",
    short: "aaaaaa",
    pid: 4242,
    host: HOST,
    ts: new Date(NOW).toISOString(),
    startedAt: new Date(NOW - 60_000).toISOString(),
    agentVersion: "0.1.0",
    model: "claude-opus-4-8",
    cwd: "/x",
    projectRoot: "/x",
    phase: "active",
    activity: null,
    ...overrides,
  }
}

const aliveProbe = (now: number) => ({ now, pidAlive: () => true, host: HOST })
const deadProbe = (now: number) => ({ now, pidAlive: () => false, host: HOST })

describe("classifyLiveness — fresh band", () => {
  it("fresh beat + pid alive ⇒ online with reported phase", () => {
    const l = classifyLiveness(rec({ phase: "busy" }), TH, aliveProbe(NOW + 1_000))
    expect(l.status).toBe("online")
    if (l.status === "online") expect(l.phase).toBe("busy")
  })

  it("fresh beat but pid provably gone ⇒ dead (rare race)", () => {
    const l = classifyLiveness(rec(), TH, deadProbe(NOW + 1_000))
    expect(l.status).toBe("dead")
  })

  it("fresh beat, cross-host (no probe) ⇒ online", () => {
    const l = classifyLiveness(rec({ host: "other.host" }), TH, {
      now: NOW + 1_000,
      pidAlive: () => false, // would say dead, but host mismatch skips probe
      host: HOST,
    })
    expect(l.status).toBe("online")
  })
})

describe("classifyLiveness — stale band (fresh < age <= stale)", () => {
  const STALE_AGE = NOW + 45_000 // 45s old, between 20s and 90s

  it("pid alive ⇒ still online (slow beat)", () => {
    expect(classifyLiveness(rec(), TH, aliveProbe(STALE_AGE)).status).toBe("online")
  })

  it("pid gone ⇒ dead", () => {
    expect(classifyLiveness(rec(), TH, deadProbe(STALE_AGE)).status).toBe("dead")
  })

  it("cross-host (can't probe) ⇒ stale (honest uncertainty)", () => {
    const l = classifyLiveness(rec({ host: "other.host" }), TH, {
      now: STALE_AGE,
      pidAlive: () => true,
      host: HOST,
    })
    expect(l.status).toBe("stale")
  })
})

describe("classifyLiveness — past stale threshold (the crash cases)", () => {
  const OLD = NOW + 120_000 // 2min old, past 90s

  it("pid alive but long silent ⇒ hung (wedged, not cleanly gone)", () => {
    expect(classifyLiveness(rec(), TH, aliveProbe(OLD)).status).toBe("hung")
  })

  it("pid gone ⇒ dead (the uncleanly-crashed session)", () => {
    const l = classifyLiveness(rec(), TH, deadProbe(OLD))
    expect(l.status).toBe("dead")
    if (l.status === "dead") expect(l.reason).toContain("pid")
  })

  it("cross-host long silent ⇒ offline (presumed gone)", () => {
    const l = classifyLiveness(rec({ host: "other.host" }), TH, {
      now: OLD,
      pidAlive: () => true,
      host: HOST,
    })
    expect(l.status).toBe("offline")
  })
})

describe("classifyLiveness — gone marker + edge cases", () => {
  it("gone marker ⇒ offline (clean exit) regardless of age", () => {
    const l = classifyLiveness(rec({ gone: true }), TH, aliveProbe(NOW + 1_000))
    expect(l.status).toBe("offline")
    if (l.status === "offline") expect(l.reason).toBe("exited")
  })

  it("unparseable timestamp + pid gone ⇒ dead", () => {
    const l = classifyLiveness(rec({ ts: "not-a-date" }), TH, deadProbe(NOW))
    expect(l.status).toBe("dead")
  })

  it("unparseable timestamp, no probe ⇒ offline", () => {
    const l = classifyLiveness(rec({ ts: "not-a-date", host: "other" }), TH, {
      now: NOW,
      pidAlive: () => true,
      host: HOST,
    })
    expect(l.status).toBe("offline")
  })

  it("no pidAlive fn at all ⇒ can't probe, fresh ⇒ online", () => {
    const l = classifyLiveness(rec(), TH, { now: NOW + 1_000, host: HOST })
    expect(l.status).toBe("online")
  })
})

describe("livenessLabel + isReachable + rank", () => {
  it("labels online phases distinctly", () => {
    expect(livenessLabel(classifyLiveness(rec({ phase: "busy" }), TH, aliveProbe(NOW)))).toBe(
      "busy",
    )
    expect(livenessLabel(classifyLiveness(rec({ phase: "idle" }), TH, aliveProbe(NOW)))).toBe(
      "idle",
    )
  })

  it("online + stale are reachable; dead/hung/offline are not", () => {
    expect(isReachable(classifyLiveness(rec(), TH, aliveProbe(NOW)))).toBe(true)
    expect(
      isReachable(classifyLiveness(rec({ host: "o" }), TH, { now: NOW + 45_000, host: HOST })),
    ).toBe(true)
    expect(isReachable(classifyLiveness(rec({ gone: true }), TH, aliveProbe(NOW)))).toBe(false)
    expect(isReachable(classifyLiveness(rec(), TH, deadProbe(NOW + 120_000)))).toBe(false)
  })

  it("rank orders online before dead", () => {
    expect(LIVENESS_RANK.online).toBeLessThan(LIVENESS_RANK.dead)
    expect(LIVENESS_RANK.online).toBeLessThan(LIVENESS_RANK.offline)
  })
})
