import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { DEFAULT_PING_TIMEOUT_MS, ensureDaemon, makeBunSocketFetch } from "./client.ts"

describe("ensureDaemon", () => {
  test("returns true immediately when socket exists and ping succeeds", async () => {
    let spawned = false
    const ok = await ensureDaemon({
      sock: "/tmp/x.sock",
      socketExists: () => true,
      ping: async () => true,
      spawn: () => {
        spawned = true
      },
    })
    expect(ok).toBe(true)
    expect(spawned).toBe(false)
  })

  test("spawns then succeeds on a later ping", async () => {
    let spawned = false
    let pings = 0
    const ok = await ensureDaemon({
      sock: "/tmp/x.sock",
      socketExists: () => false,
      ping: async () => {
        pings++
        return pings >= 3 // dead until the 3rd probe
      },
      spawn: () => {
        spawned = true
      },
      wait: async () => {},
      attempts: 5,
    })
    expect(ok).toBe(true)
    expect(spawned).toBe(true)
  })

  test("returns false when the daemon never comes up", async () => {
    const ok = await ensureDaemon({
      sock: "/tmp/x.sock",
      socketExists: () => false,
      ping: async () => false,
      spawn: () => {},
      wait: async () => {},
      attempts: 3,
    })
    expect(ok).toBe(false)
  })

  test("pings before spawning when socket already exists", async () => {
    const calls: string[] = []
    const ok = await ensureDaemon({
      sock: "/tmp/x.sock",
      socketExists: () => true,
      ping: async () => {
        calls.push("ping")
        return calls.length >= 2
      },
      spawn: () => calls.push("spawn"),
      wait: async () => {},
      attempts: 3,
    })
    expect(ok).toBe(true)
    // first ping failed -> spawn -> ping ok
    expect(calls).toEqual(["ping", "spawn", "ping"])
  })
})

describe("socket fetch timeout", () => {
  let dir: string
  let server: ReturnType<typeof Bun.listen> | undefined
  beforeEach(() => {
    const base = process.env.CDP_TEST_DIR ?? tmpdir()
    mkdirSync(base, { recursive: true })
    dir = mkdtempSync(join(base, "mute-"))
  })
  afterEach(() => {
    server?.stop(true)
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test("a ping to a socket that accepts but never answers fails within the timeout", async () => {
    const sock = join(dir, "m.sock")
    // Accepts the connection and reads the request, but never writes a reply.
    server = Bun.listen({ unix: sock, socket: { data() {} } })
    const f = makeBunSocketFetch(sock, { pingTimeoutMs: 300 })
    const t0 = Date.now()
    const outcome = await Promise.race([
      f("ping").then(
        () => "answered",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 2500)),
    ])
    const ms = Date.now() - t0
    expect(outcome).toBe("rejected")
    expect(ms).toBeLessThan(1500)
    expect(DEFAULT_PING_TIMEOUT_MS).toBe(2000)
  })
})

describe("ensureDaemon spawn lock", () => {
  let dir: string
  beforeEach(() => {
    const base = process.env.CDP_TEST_DIR ?? tmpdir()
    mkdirSync(base, { recursive: true })
    dir = mkdtempSync(join(base, "lock-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("two concurrent calls spawn the daemon once", async () => {
    let spawns = 0
    let upAt = Number.POSITIVE_INFINITY
    const deps = {
      sock: join(dir, "d.sock"),
      lockPath: join(dir, "d.sock.spawn.lock"),
      socketExists: () => false,
      ping: async () => Date.now() >= upAt,
      spawn: () => {
        spawns++
        upAt = Date.now() + 100
      },
      wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms / 10)),
      attempts: 20,
    }
    const [a, b] = await Promise.all([ensureDaemon(deps), ensureDaemon(deps)])
    expect([a, b]).toEqual([true, true])
    expect(spawns).toBe(1)
    expect(existsSync(deps.lockPath)).toBe(false)
  })

  test("a stale lock (dead pid) does not block the spawn", async () => {
    const lockPath = join(dir, "d.sock.spawn.lock")
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, time: Date.now() }))
    let spawns = 0
    const ok = await ensureDaemon({
      sock: join(dir, "d.sock"),
      lockPath,
      socketExists: () => false,
      ping: async () => spawns > 0,
      spawn: () => {
        spawns++
      },
      wait: async () => {},
      attempts: 3,
    })
    expect(ok).toBe(true)
    expect(spawns).toBe(1)
  })
})
