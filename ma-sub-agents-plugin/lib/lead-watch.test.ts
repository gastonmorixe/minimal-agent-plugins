/**
 * Unit tests for the worker-side lead watch (fix-3d): the pure decision,
 * the env parsers, the injectable watch loop, and the `agent.didStart` boot
 * hook that starts the watch only inside a worker.
 *
 * No test here can end the test runner: every watch either gets fake deps
 * (fake `exit`) or a long interval and is stopped in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import onAgentDidStart from "../handlers/on_agent_did_start.ts"

import type { HookHandlerContext } from "./host-types.ts"
import {
  activeLeadWatch,
  DEFAULT_LEAD_WATCH_MS,
  decideLeadWatch,
  ENV_LEAD_PID,
  ENV_LEAD_WATCH_MS,
  isPidAlive,
  LEAD_GONE_EXIT_CODE,
  parseLeadPid,
  parseWatchMs,
  startLeadWatch,
  startLeadWatchFromEnv,
  stopActiveLeadWatch,
} from "./lead-watch.ts"

// The real test runner may itself be a worker with MINIMAL_AGENT_LEAD_PID
// set, and startLeadWatchFromEnv deletes it from process.env by default.
// Save both keys and put them back after each test, so no test leaves the
// real var changed.
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv[ENV_LEAD_PID] = process.env[ENV_LEAD_PID]
  savedEnv[ENV_LEAD_WATCH_MS] = process.env[ENV_LEAD_WATCH_MS]
})
afterEach(() => {
  stopActiveLeadWatch()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("decideLeadWatch (pure)", () => {
  it("alive: lead exists and is still the parent", () => {
    expect(decideLeadWatch({ leadPid: 500, ppid: 500, leadAlive: true })).toBe("alive")
  })

  it("lead-gone: kill(leadPid, 0) failed with ESRCH", () => {
    expect(decideLeadWatch({ leadPid: 500, ppid: 500, leadAlive: false })).toBe("lead-gone")
    expect(decideLeadWatch({ leadPid: 500, ppid: 1, leadAlive: false })).toBe("lead-gone")
  })

  it("reparented: ppid is 1 and the lead pid is still taken (pid reuse)", () => {
    expect(decideLeadWatch({ leadPid: 500, ppid: 1, leadAlive: true })).toBe("reparented")
  })

  it("alive: ppid is not the lead but not init either (wrapper process)", () => {
    expect(decideLeadWatch({ leadPid: 500, ppid: 777, leadAlive: true })).toBe("alive")
  })

  it("alive: the lead itself is pid 1 (container init) and is the parent", () => {
    expect(decideLeadWatch({ leadPid: 1, ppid: 1, leadAlive: true })).toBe("alive")
  })
})

describe("env parsers", () => {
  it("parseLeadPid accepts a positive integer only", () => {
    expect(parseLeadPid("4242")).toBe(4242)
    expect(parseLeadPid(" 17 ")).toBe(17)
    expect(parseLeadPid(undefined)).toBeNull()
    expect(parseLeadPid("")).toBeNull()
    expect(parseLeadPid("0")).toBeNull()
    expect(parseLeadPid("-3")).toBeNull()
    expect(parseLeadPid("12abc")).toBeNull()
    expect(parseLeadPid("1.5")).toBeNull()
  })

  it("parseWatchMs defaults to 2000 and clamps tiny values", () => {
    expect(DEFAULT_LEAD_WATCH_MS).toBe(2000)
    expect(parseWatchMs(undefined)).toBe(2000)
    expect(parseWatchMs("abc")).toBe(2000)
    expect(parseWatchMs("200")).toBe(200)
    expect(parseWatchMs("1")).toBe(50)
  })
})

describe("isPidAlive", () => {
  it("is true for this process", () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it("is false for a pid that has exited and been reaped", async () => {
    const proc = Bun.spawn(["bun", "-e", "0"], { stdin: "ignore", stdout: "ignore" })
    await proc.exited
    expect(isPidAlive(proc.pid)).toBe(false)
  })
})

describe("startLeadWatch (injected deps)", () => {
  it("exits with 129 on the first tick that sees the lead gone", () => {
    let alive = true
    const exits: number[] = []
    const w = startLeadWatch(500, 60_000, {
      isAlive: () => alive,
      ppid: () => 500,
      exit: (c) => exits.push(c),
    })
    expect(w.tick()).toBe("alive")
    expect(exits).toEqual([])
    alive = false
    expect(w.tick()).toBe("lead-gone")
    expect(exits).toEqual([LEAD_GONE_EXIT_CODE])
    w.stop()
  })

  it("exits with 129 when reparented to init", () => {
    const exits: number[] = []
    const w = startLeadWatch(500, 60_000, {
      isAlive: () => true,
      ppid: () => 1,
      exit: (c) => exits.push(c),
    })
    expect(w.tick()).toBe("reparented")
    expect(exits).toEqual([129])
    w.stop()
  })

  it("runs on its own timer", async () => {
    const exits: number[] = []
    const w = startLeadWatch(500, 50, {
      isAlive: () => false,
      ppid: () => 500,
      exit: (c) => exits.push(c),
    })
    await Bun.sleep(200)
    w.stop()
    expect(exits[0]).toBe(129)
  })
})

describe("startLeadWatchFromEnv", () => {
  it("starts nothing when MINIMAL_AGENT_LEAD_PID is unset", () => {
    expect(startLeadWatchFromEnv({})).toBeNull()
    expect(activeLeadWatch()).toBeNull()
  })

  it("starts one watch with the env interval, and is idempotent", () => {
    const deps = { isAlive: () => true, ppid: () => process.pid, exit: () => {} }
    const env = { [ENV_LEAD_PID]: String(process.pid), [ENV_LEAD_WATCH_MS]: "60000" }
    const a = startLeadWatchFromEnv(env, deps)
    expect(a?.leadPid).toBe(process.pid)
    expect(a?.intervalMs).toBe(60_000)
    expect(activeLeadWatch()).toBe(a)
    expect(startLeadWatchFromEnv(env, deps)).toBe(a)
  })
})

describe("startLeadWatchFromEnv env scrub (fix-3i)", () => {
  const deps = { isAlive: () => true, ppid: () => process.pid, exit: () => {} }

  it("deletes both keys from the scrub target and still watches the read pid", () => {
    const env = { [ENV_LEAD_PID]: String(process.pid), [ENV_LEAD_WATCH_MS]: "60000" }
    const scrub: Record<string, string | undefined> = { ...env, KEEP: "yes" }
    const w = startLeadWatchFromEnv(env, deps, scrub)
    expect(w?.leadPid).toBe(process.pid)
    expect(w?.intervalMs).toBe(60_000)
    expect(scrub).toEqual({ KEEP: "yes" })
  })

  it("removes the var from process.env, so a later Bun.spawn child does not see it", async () => {
    process.env[ENV_LEAD_PID] = String(process.pid)
    process.env[ENV_LEAD_WATCH_MS] = "60000"
    const w = startLeadWatchFromEnv(process.env, deps)
    expect(w?.leadPid).toBe(process.pid)
    expect(process.env[ENV_LEAD_PID]).toBeUndefined()
    expect(process.env[ENV_LEAD_WATCH_MS]).toBeUndefined()
    // Core's Bash tool passes an explicit env built from `process.env`
    // (tools.ts `childEnv({ ...process.env, ... })`), so spread it here too.
    const child = Bun.spawn(["printenv", ENV_LEAD_PID], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(child.stdout).text()
    // printenv exits 1 when the var is not set.
    expect(await child.exited).toBe(1)
    expect(out.trim()).toBe("")
  })

  it("the boot hook scrubs process.env too", () => {
    process.env[ENV_LEAD_PID] = String(process.pid)
    process.env[ENV_LEAD_WATCH_MS] = "60000"
    onAgentDidStart({}, { cwd: process.cwd(), env: { ...process.env } as Record<string, string> })
    expect(activeLeadWatch()?.leadPid).toBe(process.pid)
    expect(process.env[ENV_LEAD_PID]).toBeUndefined()
    expect(process.env[ENV_LEAD_WATCH_MS]).toBeUndefined()
  })
})

describe("on_agent_did_start boot hook", () => {
  const ctx = (env: Record<string, string>): HookHandlerContext => ({ cwd: process.cwd(), env })

  it("starts the lead watch inside a worker (env set)", () => {
    // Lead = this test process, so the lead is alive. Long interval: the
    // first real tick never runs before afterEach stops the watch.
    onAgentDidStart({}, ctx({ [ENV_LEAD_PID]: String(process.pid), [ENV_LEAD_WATCH_MS]: "60000" }))
    const w = activeLeadWatch()
    expect(w).not.toBeNull()
    expect(w?.leadPid).toBe(process.pid)
    expect(w?.intervalMs).toBe(60_000)
  })

  it("does not start a watch in a lead (env unset)", () => {
    onAgentDidStart({}, ctx({}))
    expect(activeLeadWatch()).toBeNull()
  })
})
