import { describe, expect, it } from "bun:test"

import type { Thresholds } from "./config.ts"
import type { PresenceRecord } from "./presence.ts"
import { buildRoster, mergePresence, rosterCounts } from "./roster.ts"

const TH: Thresholds = { heartbeatMs: 5_000, freshMs: 20_000, staleMs: 90_000 }
const HOST = "h"
const NOW = Date.parse("2026-06-13T12:00:00.000Z")

function rec(sid: string, overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    v: 1,
    sid,
    short: sid.slice(0, 6),
    pid: 100,
    host: HOST,
    ts: new Date(NOW).toISOString(),
    startedAt: new Date(NOW - 60_000).toISOString(),
    agentVersion: "0.1.0",
    model: "m",
    cwd: "/c",
    projectRoot: "/c",
    phase: "active",
    activity: null,
    ...overrides,
  }
}

const probe = { now: NOW + 1_000, pidAlive: () => true, host: HOST }

describe("mergePresence", () => {
  it("keeps the newest beat per sid across sources", () => {
    const a = [rec("x", { ts: new Date(NOW).toISOString(), model: "old" })]
    const b = [rec("x", { ts: new Date(NOW + 10_000).toISOString(), model: "new" })]
    const merged = mergePresence(a, b)
    expect(merged.length).toBe(1)
    expect(merged[0]?.model).toBe("new")
  })
})

describe("buildRoster", () => {
  it("flags self and can exclude it", () => {
    const recs = [rec("self-1"), rec("peer-2")]
    const withSelf = buildRoster(recs, { thresholds: TH, probe, selfSid: "self-1" })
    expect(withSelf.find((r) => r.record.sid === "self-1")?.isSelf).toBe(true)

    const without = buildRoster(recs, {
      thresholds: TH,
      probe,
      selfSid: "self-1",
      excludeSelf: true,
    })
    expect(without.find((r) => r.record.sid === "self-1")).toBeUndefined()
  })

  it("liveOnly drops dead/offline rows", () => {
    const recs = [rec("alive-1"), rec("gone-2", { gone: true })]
    const rows = buildRoster(recs, { thresholds: TH, probe, liveOnly: true })
    expect(rows.map((r) => r.record.sid)).toEqual(["alive-1"])
  })

  it("sorts reachable before dead", () => {
    const recs = [
      rec("dead-1", { ts: new Date(NOW - 300_000).toISOString() }), // very old
      rec("live-2"),
    ]
    const deadProbe = { now: NOW + 1_000, pidAlive: () => false, host: HOST }
    const rows = buildRoster(recs, { thresholds: TH, probe: deadProbe })
    expect(rows[0]?.record.sid).toBe("live-2")
  })
})

describe("rosterCounts", () => {
  it("counts busy/idle/online and excludes self", () => {
    const recs = [
      rec("self", { phase: "busy" }),
      rec("p1", { phase: "busy" }),
      rec("p2", { phase: "idle" }),
    ]
    const rows = buildRoster(recs, { thresholds: TH, probe, selfSid: "self" })
    const c = rosterCounts(rows)
    expect(c.total).toBe(2) // self excluded
    expect(c.busy).toBe(1)
    expect(c.idle).toBe(1)
  })
})
