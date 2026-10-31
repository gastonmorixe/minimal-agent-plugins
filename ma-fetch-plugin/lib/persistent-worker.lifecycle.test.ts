import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

/**
 * Process-level contract for the persistent Fetch worker spawn shape:
 * `Bun.spawn({ detached: true, stdin: "pipe" })`.
 *
 * macOS has no PR_SET_PDEATHSIG. The child must still die when the parent is
 * SIGKILL'd because the OS closes the parent's write end → stdin EOF. Obscura's
 * fetch worker exits on EOF. Do NOT "fix" orphans by dropping `detached`:
 * detached is the process-group leader flag used to group-kill Chromium.
 *
 * Do NOT assert death with `kill(pid, 0)` (ESRCH). That only goes false once
 * the child has been *reaped* -- after SIGKILL'ing `parent`, the child is
 * orphaned and reparented to PID 1/a subreaper, which reaps it on its own,
 * unrelated schedule. Measured on this box: the child's own EOF→close→exit
 * chain completes in under 100ms every time, but the external reaper can leave it
 * as an unreaped zombie (still "alive" to `kill(pid, 0)`) for ~1-1.9s even
 * with no other load, and well past 2s under concurrent CPU contention --
 * not because the plugin's EOF handling is slow, but because an unrelated
 * process (the container's init) hasn't gotten around to `wait()`ing on it
 * yet. That made this test race the reaper's cadence, not the behavior it's
 * meant to check. Have the child itself record the moment its "close"
 * handler ran (before calling exit), and assert on that file instead: it is
 * written synchronously inside the real EOF handler, so it reports the
 * actual contract under test with no dependency on reap timing.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(20)
  }
  return pred()
}

describe("persistent worker process death contract", () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `ma-fetch-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("detached stdin-pipe child dies when the parent is SIGKILL'd", async () => {
    const childPath = join(dir, "child.ts")
    const parentPath = join(dir, "parent.ts")
    const diedMarkerPath = join(dir, "died.marker")
    writeFileSync(
      childPath,
      `const rl = require("node:readline").createInterface({ input: process.stdin })
rl.on("close", () => {
  require("node:fs").writeFileSync(${JSON.stringify(diedMarkerPath)}, "1")
  process.exit(0)
})
setInterval(() => {}, 1 << 30)
`,
    )
    writeFileSync(
      parentPath,
      `const child = Bun.spawn(["bun", ${JSON.stringify(childPath)}], {
  stdin: "pipe",
  stdout: "ignore",
  stderr: "ignore",
  detached: true,
})
if (!child.pid) throw new Error("no child pid")
await Bun.stdout.write(String(child.pid) + "\\n")
await Bun.sleep(1 << 30)
`,
    )

    const parent = Bun.spawn(["bun", parentPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(parent.pid).toBeGreaterThan(0)

    const reader = parent.stdout?.getReader()
    expect(reader).toBeDefined()
    if (!reader) throw new Error("parent stdout missing")
    const decoder = new TextDecoder()
    let buf = ""
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) buf += decoder.decode(value, { stream: true })
    }
    const childPid = Number.parseInt(buf.trim(), 10)
    expect(childPid).toBeGreaterThan(0)
    expect(pidAlive(childPid)).toBe(true)

    process.kill(parent.pid!, "SIGKILL")
    // 5s is a circuit breaker for a real regression (child never reacting
    // to EOF), not a tuned race margin: measured on this box, the marker
    // above lands in <200ms unloaded and <1s under one concurrent
    // `bun run check` (the realistic CI case); only a pathological,
    // far-beyond-CI pile-up of several full suites at once pushed it past
    // ~2.7s. The test-level timeout below (10s) just needs to stay above
    // this wait so bun's own default 5s test timeout can't fire first.
    const childDied = await waitUntil(() => existsSync(diedMarkerPath), 5_000)
    expect(childDied).toBe(true)
  }, 10_000)
})
