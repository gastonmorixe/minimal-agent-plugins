import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  envInt,
  leaseDirFor,
  pidAlive,
  shouldIdleExit,
  sweepLeases,
  writeLease,
} from "./lifetime.ts"
import { DEFAULT_LOCK_STALE_MS, isLockStale, type Release, tryAcquireLock } from "./spawn-lock.ts"

let dir: string
beforeEach(() => {
  const base = process.env.CDP_TEST_DIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, "life-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("lifetime helpers", () => {
  test("pidAlive: this process yes, bad pids no", () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(999_999_999)).toBe(false)
  })

  test("envInt: integers only, else the fallback", () => {
    expect(envInt("500", 1)).toBe(500)
    expect(envInt("0", 1)).toBe(0)
    expect(envInt(undefined, 7)).toBe(7)
    expect(envInt("", 7)).toBe(7)
    expect(envInt("-3", 7)).toBe(7)
    expect(envInt("1.5", 7)).toBe(7)
    expect(envInt("abc", 7)).toBe(7)
  })

  test("leaseDirFor: override wins, else <sock>.leases", () => {
    expect(leaseDirFor("/s/d.sock")).toBe("/s/d.sock.leases")
    expect(leaseDirFor("/s/d.sock", "")).toBe("/s/d.sock.leases")
    expect(leaseDirFor("/s/d.sock", "/x")).toBe("/x")
  })

  test("sweepLeases counts live pids and removes dead ones", () => {
    const leases = join(dir, "leases")
    writeLease(leases, 101)
    writeLease(leases, 202)
    writeFileSync(join(leases, "not-a-pid"), "")
    const live = sweepLeases(leases, (pid) => pid === 101)
    expect(live).toBe(1)
    expect(existsSync(join(leases, "101"))).toBe(true)
    expect(existsSync(join(leases, "202"))).toBe(false)
    expect(existsSync(join(leases, "not-a-pid"))).toBe(true)
    expect(sweepLeases(join(dir, "missing"))).toBe(0)
  })

  test("sweepLeases removes a live-pid lease older than the max age", () => {
    const leases = join(dir, "leases")
    mkdirSync(leases, { recursive: true })
    const now = 1_000_000
    const old = join(leases, String(process.pid))
    const fresh = join(leases, "101")
    writeFileSync(old, JSON.stringify({ pid: process.pid, time: now - 10_000 }))
    writeFileSync(fresh, JSON.stringify({ pid: 101, time: now - 1000 }))
    expect(sweepLeases(leases, () => true, 5000, now)).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test("writeLease stores pid and time, and a rewrite refreshes the time", () => {
    const leases = join(dir, "leases")
    writeLease(leases, 303)
    const f = join(leases, "303")
    const a = JSON.parse(readFileSync(f, "utf8")) as { pid: number; time: number }
    expect(a.pid).toBe(303)
    expect(Math.abs(a.time - Date.now())).toBeLessThan(5000)
    // An old lease is refreshed by the next write, so the sweep keeps it.
    writeFileSync(f, JSON.stringify({ pid: 303, time: 1 }))
    writeLease(leases, 303)
    expect(sweepLeases(leases, () => true, 5000)).toBe(1)
  })

  test("shouldIdleExit needs no lease, idle on, and the limit passed", () => {
    const base = { liveLeases: 0, idleMs: 500, lastActivity: 1000 }
    expect(shouldIdleExit({ ...base, now: 1500 })).toBe(true)
    expect(shouldIdleExit({ ...base, now: 1499 })).toBe(false)
    expect(shouldIdleExit({ ...base, liveLeases: 1, now: 9999 })).toBe(false)
    expect(shouldIdleExit({ ...base, idleMs: 0, now: 9999 })).toBe(false)
  })
})

describe("spawn lock", () => {
  test("a second acquire fails while the first holds it, then succeeds", () => {
    const p = join(dir, "x.lock")
    const r1 = tryAcquireLock(p)
    expect(r1).toBeDefined()
    expect(tryAcquireLock(p)).toBeUndefined()
    r1?.()
    expect(existsSync(p)).toBe(false)
    const r2 = tryAcquireLock(p)
    expect(r2).toBeDefined()
    r2?.()
  })

  test("stale: dead pid or too old", () => {
    const p = join(dir, "y.lock")
    const now = 100_000
    writeFileSync(p, JSON.stringify({ pid: 5, time: now }))
    expect(isLockStale(p, 10_000, now, () => true)).toBe(false)
    expect(isLockStale(p, 10_000, now, () => false)).toBe(true)
    expect(isLockStale(p, 10_000, now + 10_001, () => true)).toBe(true)
    expect(isLockStale(join(dir, "none.lock"))).toBe(true)
  })

  test("two breakers of one stale lock, interleaved: exactly one holds it", () => {
    for (let round = 0; round < 20; round++) {
      const p = join(dir, `r${round}.lock`)
      writeFileSync(p, JSON.stringify({ pid: 999_999_999, time: Date.now(), token: "dead" }))
      let a: Release | undefined
      let hookRan = false
      // B judges the lock stale. Then A breaks it and takes it before B acts.
      const b = tryAcquireLock(p, DEFAULT_LOCK_STALE_MS, () => {
        if (hookRan) return
        hookRan = true
        a = tryAcquireLock(p)
      })
      expect(hookRan).toBe(true)
      expect([a, b].filter((r) => r !== undefined).length).toBe(1)
      expect(a).toBeDefined()
      expect(existsSync(p)).toBe(true)
      a?.()
      b?.()
      expect(readdirSync(dir).filter((n) => n.startsWith(`r${round}.lock`))).toEqual([])
    }
  })

  test("two breaker processes on one stale lock: exactly one gets it (20 rounds)", async () => {
    const fixture = join(import.meta.dir, "spawn-lock.race.fixture.ts")
    for (let round = 0; round < 20; round++) {
      const p = join(dir, `q${round}.lock`)
      writeFileSync(p, JSON.stringify({ pid: 999_999_999, time: Date.now(), token: "dead" }))
      const startAt = String(Date.now() + 300)
      const kids = [0, 1].map(() =>
        Bun.spawn([process.execPath, fixture, p, startAt], { stdout: "pipe", stderr: "ignore" }),
      )
      try {
        const outs = await Promise.all(kids.map((k) => new Response(k.stdout).text()))
        await Promise.all(kids.map((k) => k.exited))
        expect(outs.filter((o) => o === "got").length).toBe(1)
        expect(outs.filter((o) => o === "none").length).toBe(1)
      } finally {
        for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL")
      }
    }
  }, 30_000)

  test("release does not remove a lock taken over by another holder", () => {
    const p = join(dir, "z.lock")
    const r1 = tryAcquireLock(p)
    writeFileSync(p, JSON.stringify({ pid: process.pid, time: Date.now(), token: "other" }))
    r1?.()
    expect(existsSync(p)).toBe(true)
  })
})
