import { describe, expect, test } from "bun:test"

import { ensureDaemon } from "./client.ts"

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
