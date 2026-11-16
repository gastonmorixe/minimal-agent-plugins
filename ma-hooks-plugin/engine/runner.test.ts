/**
 * SIGINT/SIGTERM cleanup of hook process groups (review MINOR 8). No real
 * signal reaches the test process: the tests call the signal path with a
 * fake `raise`, or emit the event while a second listener owns the signal.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  type CleanupSignal,
  cleanupListener,
  liveGroupPids,
  onCleanupSignal,
  runHandler,
  uninstallCleanup,
} from "./runner.ts"
import { makeSandbox, type Sandbox } from "./test-support.ts"
import type { RunOutcome } from "./types.ts"

let sb: Sandbox

beforeEach(() => {
  sb = makeSandbox()
})

afterEach(() => {
  uninstallCleanup()
  sb.cleanup()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out")
    await Bun.sleep(20)
  }
}

/** Start a hook that leaves a long-lived grandchild. Returns the run and the grandchild pid. */
async function startHang(): Promise<{ run: Promise<RunOutcome>; grandchild: number }> {
  const pidFile = join(sb.root, "grandchild.pid")
  const s = sb.script("hang.sh", `sleep 60 &\necho $! > ${pidFile}\nwait`)
  const run = runHandler({
    handler: { type: "command", command: s },
    stdin: "{}",
    env: {},
    cwd: sb.project,
    timeoutMs: 60_000,
    baseEnv: sb.env,
  })
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")
  const grandchild = Number(readFileSync(pidFile, "utf8").trim())
  expect(alive(grandchild)).toBe(true)
  return { run, grandchild }
}

describe("signal cleanup (MINOR 8)", () => {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as CleanupSignal[]) {
    test(`${sig}: the only listener kills the group, removes itself and raises the signal again`, async () => {
      const { run, grandchild } = await startHang()
      expect(liveGroupPids().length).toBe(1)
      const raised: string[] = []
      onCleanupSignal(sig, (s) => raised.push(s))
      await run
      await waitFor(() => !alive(grandchild))
      expect(liveGroupPids()).toEqual([])
      expect(raised).toEqual([sig])
      expect(process.listeners(sig)).not.toContain(cleanupListener(sig))
    })
  }

  test("process.emit SIGTERM with a host listener: group killed, no re-raise, no exit", async () => {
    const { run, grandchild } = await startHang()
    let hostSaw = 0
    const host = () => {
      hostSaw++
    }
    process.on("SIGTERM", host)
    try {
      process.emit("SIGTERM")
      await run
      await waitFor(() => !alive(grandchild))
      expect(hostSaw).toBe(1)
      // The host owns the signal: our listener stays for the next one.
      expect(process.listeners("SIGTERM")).toContain(cleanupListener("SIGTERM"))
    } finally {
      process.removeListener("SIGTERM", host)
    }
  })

  test("listeners are added once, however many hooks run", async () => {
    const before = process.listeners("SIGINT").length
    for (let i = 0; i < 3; i++) {
      await runHandler({
        handler: { type: "command", command: "true" },
        stdin: "",
        env: {},
        cwd: sb.project,
        timeoutMs: 5000,
        baseEnv: sb.env,
      })
    }
    expect(process.listeners("SIGINT").length).toBe(before + 1)
    expect(
      process.listeners("SIGTERM").filter((l) => l === cleanupListener("SIGTERM")),
    ).toHaveLength(1)
    expect(liveGroupPids()).toEqual([])
  })
})

describe("http header env (MINOR 1, Claude hooks-reference.md:513)", () => {
  test("allowed $VAR / ${VAR} resolve, unlisted references become empty", async () => {
    let seen: Record<string, string> = {}
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = Object.fromEntries(req.headers.entries())
        return new Response("")
      },
    })
    try {
      const r = await runHandler({
        handler: {
          type: "http",
          url: `http://127.0.0.1:${server.port}/hook`,
          headers: {
            "x-ok": "Bearer $OK_TOKEN",
            "x-ok-braced": "${OK_TOKEN}!",
            "x-secret": "a-$SECRET_KEY-b",
            "x-secret-braced": "a${SECRET_KEY}b",
          },
          allowedEnvVars: ["OK_TOKEN"],
        },
        stdin: "{}",
        env: {},
        cwd: sb.root,
        timeoutMs: 5000,
        baseEnv: { OK_TOKEN: "t1", SECRET_KEY: "s3cret" },
      })
      expect(r.exitCode).toBe(0)
      expect(seen["x-ok"]).toBe("Bearer t1")
      expect(seen["x-ok-braced"]).toBe("t1!")
      expect(seen["x-secret"]).toBe("a--b")
      expect(seen["x-secret-braced"]).toBe("ab")
    } finally {
      await server.stop(true)
    }
  })
})
