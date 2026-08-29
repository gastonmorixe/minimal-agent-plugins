import { mkdirSync, rmSync, writeFileSync } from "node:fs"
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
    writeFileSync(
      childPath,
      `const rl = require("node:readline").createInterface({ input: process.stdin })
rl.on("close", () => process.exit(0))
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
    const childDied = await waitUntil(() => !pidAlive(childPid), 2000)
    expect(childDied).toBe(true)
  })
})
