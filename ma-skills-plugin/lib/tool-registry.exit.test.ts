/**
 * fix-3i: detached skill scripts die when the host CLI exits.
 *
 * A skill script runs with `detached: true` (own session and group), so a
 * terminal SIGHUP never reaches it and Bun kills no child on exit. The
 * registry keeps a set of live script groups and ONE `exit` listener that
 * SIGKILLs each group.
 *
 * Every pid a test learns is SIGKILLed by exact pid in `afterEach`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import * as registry from "./tool-registry.ts"
import type { ToolSpec } from "./types.ts"

/** Snapshot of the tracked script groups, or `undefined` before the fix. */
const liveGroups = (): number[] | undefined =>
  (registry as { liveScriptGroupPids?: () => number[] }).liveScriptGroupPids?.()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(20)
  }
  return !alive(pid)
}

async function readPids(file: string, started: number[]): Promise<number[]> {
  // Same bound as the host fixture: a slow `bun` start under load must not fail the read.
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (existsSync(file)) {
      const pids = readFileSync(file, "utf8").trim().split(/\s+/).map(Number)
      if (pids.length === 2 && pids.every((p) => p > 0)) {
        started.push(...pids)
        return pids
      }
    }
    await Bun.sleep(20)
  }
  throw new Error("script did not write its pids")
}

type Invoker = { invoke: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>> }

function handler(dir: string, path: string): Invoker {
  const spec = {
    name: "Exit",
    description: "exit test",
    parameters: { type: "object", properties: {} },
    handler: { type: "script", path, argTemplate: "x", timeoutMs: 30_000 },
  } as unknown as ToolSpec
  return registry.toolSpecToHandler(spec, dir, { env: { PATH: process.env.PATH } }) as Invoker
}

describe("skill script exit hook (fix-3i)", () => {
  let dir: string
  const started: number[] = []
  // The shell pid variable is built by repeat so no editor collapses the pair.
  const selfPid = "$".repeat(2)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-exit-"))
    mkdirSync(join(dir, "scripts"))
    const pids = join(dir, "pids")
    // Background sleep plus a blocking sleep on the script pid.
    writeFileSync(
      join(dir, "scripts", "forks"),
      `#!/bin/sh\nsleep 300 &\necho "${selfPid} $!" > "${pids}"\nexec sleep 300\n`,
    )
    // Exits at once with no child left. Prints its own pid (= its pgid).
    writeFileSync(join(dir, "scripts", "quick"), `#!/bin/sh\necho "${selfPid}"\n`)
    // Exits at once but leaves a background sleep in its group.
    writeFileSync(
      join(dir, "scripts", "leaves"),
      // The sleep must not hold the stdout pipe, or the invoke never returns.
      `#!/bin/sh\nsleep 300 > /dev/null 2>&1 &\necho "${selfPid} $!" > "${pids}"\necho left\n`,
    )
    for (const s of ["forks", "quick", "leaves"]) chmodSync(join(dir, "scripts", s), 0o755)
  })

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("host process.exit(0) kills an in-flight script and its background child within 2 s", async () => {
    const fixture = join(import.meta.dir, "tool-registry.exit-fixture.ts")
    const host = Bun.spawn(["bun", fixture, dir], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })
    started.push(host.pid)
    const [script, bg] = await readPids(join(dir, "pids"), started)
    const code = await host.exited
    // The host is reaped: drop its pid so afterEach never signals a reused pid.
    started.splice(started.indexOf(host.pid), 1)
    expect(code).toBe(0)
    expect(await waitGone(script, 2000)).toBe(true)
    expect(await waitGone(bg, 2000)).toBe(true)
  })

  // The set is module state shared with other test files in this process, so
  // each assertion checks only the pid of its own script.
  test("the set drops a finished script whose group is empty", async () => {
    const r = await handler(dir, "scripts/quick").invoke({ trigger: { type: "tool", input: {} } })
    const pid = Number(r.content)
    expect(pid).toBeGreaterThan(1)
    const groups = liveGroups()
    expect(groups).toBeDefined()
    expect(groups).not.toContain(pid)
  })

  test("the set keeps a finished script whose group still has a live child", async () => {
    const r = await handler(dir, "scripts/leaves").invoke({ trigger: { type: "tool", input: {} } })
    expect(r.content).toBe("left")
    const [script, bg] = await readPids(join(dir, "pids"), started)
    expect(alive(bg)).toBe(true)
    expect(liveGroups()).toContain(script)
    // Kill the leftover group, then a new track call prunes the stale entry.
    process.kill(bg, "SIGKILL")
    expect(await waitGone(bg, 2000)).toBe(true)
    // The script leader is reaped by Bun, so the group empties with the sleep.
    await handler(dir, "scripts/quick").invoke({ trigger: { type: "tool", input: {} } })
    expect(liveGroups()).not.toContain(script)
  })
})
