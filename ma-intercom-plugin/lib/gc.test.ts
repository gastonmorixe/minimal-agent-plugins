import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { Thresholds } from "./config.ts"
import {
  type AuxFile,
  FOREIGN_GC_TTL_MS,
  ORPHAN_GC_TTL_MS,
  PRESENCE_GC_TTL_MS,
  type PresenceFile,
  planForeignGc,
  planOrphanGc,
  planPresenceGc,
  runGc,
} from "./gc.ts"
import type { LivenessProbe } from "./liveness.ts"
import { cursorsDir, inboxDir, presenceDir } from "./paths.ts"
import { type PresenceRecord, writePresence } from "./presence.ts"
import { selfDir } from "./selfstate.ts"

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

describe("planPresenceGc (pure)", () => {
  const probe: LivenessProbe = { now: NOW, pidAlive: () => false, host: HOST }

  it("prunes a dead record older than the TTL", () => {
    const old = new Date(NOW - PRESENCE_GC_TTL_MS - 60_000).toISOString()
    const files: PresenceFile[] = [{ sid: "d", path: "/p/d.json", record: rec("d", { ts: old }) }]
    expect(planPresenceGc(files, TH, probe)).toEqual(["/p/d.json"])
  })

  it("keeps a freshly-dead record (within TTL) so 'died 2m ago' still shows", () => {
    const recent = new Date(NOW - 60_000).toISOString() // 1m old, dead but < 10m TTL
    const files: PresenceFile[] = [
      { sid: "d", path: "/p/d.json", record: rec("d", { ts: recent }) },
    ]
    expect(planPresenceGc(files, TH, probe)).toEqual([])
  })

  it("never prunes a live (fresh) record", () => {
    const aliveProbe: LivenessProbe = { now: NOW, pidAlive: () => true, host: HOST }
    const files: PresenceFile[] = [{ sid: "a", path: "/p/a.json", record: rec("a") }]
    expect(planPresenceGc(files, TH, aliveProbe)).toEqual([])
  })

  it("always prunes a corrupt (null) record", () => {
    const files: PresenceFile[] = [{ sid: "x", path: "/p/x.json", record: null }]
    expect(planPresenceGc(files, TH, probe)).toEqual(["/p/x.json"])
  })

  it("prunes an offline (cleanly-gone) record past TTL", () => {
    const old = new Date(NOW - PRESENCE_GC_TTL_MS - 1).toISOString()
    const files: PresenceFile[] = [
      { sid: "o", path: "/p/o.json", record: rec("o", { gone: true, ts: old }) },
    ]
    expect(planPresenceGc(files, TH, probe)).toEqual(["/p/o.json"])
  })
})

describe("planOrphanGc (pure)", () => {
  it("prunes an aux file with no live owner and aged out", () => {
    const files: AuxFile[] = [
      { sid: "gone", path: "/i/gone.jsonl", mtimeMs: NOW - ORPHAN_GC_TTL_MS - 1 },
    ]
    expect(planOrphanGc(files, new Set(), NOW)).toEqual(["/i/gone.jsonl"])
  })

  it("keeps an aux file whose owner is still live", () => {
    const files: AuxFile[] = [
      { sid: "live", path: "/i/live.jsonl", mtimeMs: NOW - ORPHAN_GC_TTL_MS - 1 },
    ]
    expect(planOrphanGc(files, new Set(["live"]), NOW)).toEqual([])
  })

  it("keeps a recently-touched orphan (within TTL) so a resuming session keeps mail", () => {
    const files: AuxFile[] = [{ sid: "soon", path: "/i/soon.jsonl", mtimeMs: NOW - 60_000 }]
    expect(planOrphanGc(files, new Set(), NOW)).toEqual([])
  })
})

describe("planForeignGc (pure) — the sub-agents graveyard sweep", () => {
  it("prunes a stale dead-lead file (mtime past TTL)", () => {
    const files: AuxFile[] = [
      { sid: "lead", path: "/p/lead.jsonl", mtimeMs: NOW - FOREIGN_GC_TTL_MS - 1 },
    ]
    expect(planForeignGc(files, NOW)).toEqual(["/p/lead.jsonl"])
  })
  it("keeps a fresh live-lead file (rewritten within TTL)", () => {
    const files: AuxFile[] = [{ sid: "lead", path: "/p/lead.jsonl", mtimeMs: NOW - 3_000 }]
    expect(planForeignGc(files, NOW)).toEqual([])
  })
})

describe("runGc (io, end-to-end)", () => {
  it("deletes dead presence + orphan aux, keeps live ones, under a temp home", () => {
    const home = mkdtempSync(join(tmpdir(), "intercom-gc-"))
    const env: NodeJS.ProcessEnv = { MINIMAL_AGENT_HOME: home }
    try {
      // Use real wall-clock as the GC `now` so it's strictly after the mtimes
      // of the files we write microseconds from now (the orphan path compares
      // file mtime to `now`).
      const realNow = Date.now()
      // A live session (fresh beat, pid alive).
      writePresence(
        join(presenceDir(env), "live-1.json"),
        rec("live-1", { ts: new Date(realNow).toISOString() }),
      )
      // A dead session (old beat, pid gone).
      const old = new Date(realNow - PRESENCE_GC_TTL_MS - 60_000).toISOString()
      writePresence(join(presenceDir(env), "dead-9.json"), rec("dead-9", { ts: old, pid: 999 }))

      // Aux files: one owned by the live session, one orphan (old, no owner).
      mkdirSync(inboxDir(env), { recursive: true })
      writeFileSync(join(inboxDir(env), "live-1.jsonl"), "{}\n")
      const orphan = join(inboxDir(env), "ghost-7.jsonl")
      writeFileSync(orphan, "{}\n")
      // Age the orphan past the TTL by faking mtime via an old write is hard;
      // instead use a tiny orphanTtlMs so "just now" counts as aged out.

      const res = runGc({
        env,
        // Capture the clock at GC time so it's strictly after the just-written
        // file mtimes (a file written microseconds ago has age >= 0).
        now: Date.now() + 1000,
        thresholds: TH,
        pidAlive: (pid) => pid === 100, // live-1 uses pid 100; dead-9 uses 999
        host: HOST,
        orphanTtlMs: 0, // any positive age is orphan-eligible
      })

      expect(res.prunedPresence).toBe(1)
      expect(existsSync(join(presenceDir(env), "live-1.json"))).toBe(true)
      expect(existsSync(join(presenceDir(env), "dead-9.json"))).toBe(false)
      // live-1's inbox is kept (owner live); ghost-7 is reaped.
      expect(existsSync(join(inboxDir(env), "live-1.jsonl"))).toBe(true)
      expect(existsSync(orphan)).toBe(false)
      expect(res.prunedOrphans).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("is a no-op on an empty store and never throws", () => {
    const home = mkdtempSync(join(tmpdir(), "intercom-gc-empty-"))
    const env: NodeJS.ProcessEnv = { MINIMAL_AGENT_HOME: home }
    try {
      const res = runGc({ env, now: NOW, thresholds: TH, pidAlive: () => false, host: HOST })
      expect(res).toEqual({ prunedPresence: 0, prunedOrphans: 0, prunedForeign: 0 })
      // exercise unused dirs so the import is meaningful
      expect(typeof cursorsDir(env)).toBe("string")
      expect(typeof selfDir(env)).toBe("string")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
