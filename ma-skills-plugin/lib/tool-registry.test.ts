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

import { skillScriptEnv, toolSpecToHandler } from "./tool-registry.ts"
import type { ToolSpec } from "./types.ts"

describe("skillScriptEnv", () => {
  test("drops BUN_BE_BUN and undefined values, keeps the rest", () => {
    expect(skillScriptEnv({ PATH: "/bin", BUN_BE_BUN: "1", GONE: undefined })).toEqual({
      PATH: "/bin",
    })
  })
})

describe("script tool handler env", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-env-"))
    mkdirSync(join(dir, "scripts"))
    const script = join(dir, "scripts", "show-env")
    writeFileSync(script, '#!/bin/sh\necho "be=${BUN_BE_BUN-unset} keep=${SKILL_KEEP-unset}"\n')
    chmodSync(script, 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("the script runs by shebang and never sees BUN_BE_BUN", async () => {
    const spec = {
      name: "ShowEnv",
      description: "print env",
      parameters: { type: "object", properties: {} },
      handler: { type: "script", path: "scripts/show-env", argTemplate: "x" },
    } as unknown as ToolSpec
    const h = toolSpecToHandler(spec, dir, {
      env: { PATH: process.env.PATH, BUN_BE_BUN: "1", SKILL_KEEP: "yes" },
    }) as { invoke: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const r = await h.invoke({ trigger: { type: "tool", input: {} } })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toBe("be=unset keep=yes")
  })
})

/** True while `pid` exists (signal 0 probe). */
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

/** Resolve with `p`, or reject when `p` does not settle within `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`invoke did not return within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

describe("script tool handler timeout and abort", () => {
  let dir: string
  const started: number[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-kill-"))
    mkdirSync(join(dir, "scripts"))
    const script = join(dir, "scripts", "forks")
    // Write the script pid and the background sleep pid to a file, then block.
    // `exec` keeps the blocking sleep on the script pid, so 2 pids cover all.
    // The shell pid variable is built by repeat so no editor collapses the pair.
    const selfPid = "$".repeat(2)
    writeFileSync(
      script,
      `#!/bin/sh\n[ -n "$SKILL_TEST_WARM" ] && exit 0\nsleep 300 &\necho "${selfPid} $!" > "${join(dir, "pids")}"\nexec sleep 300\n`,
    )
    chmodSync(script, 0o755)
    // Run the new script once before the test. On macOS the first exec of a new
    // executable file takes about 220 ms (the system scans it), and the next
    // one about 12 ms. The timeout test gives the handler a short timeout, and
    // without this run the script was killed before it wrote its pids when the
    // machine was busy: "script did not write its pids".
    Bun.spawnSync([script], { env: { PATH: process.env.PATH, SKILL_TEST_WARM: "1" } })
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

  function handler(timeoutMs: number) {
    const spec = {
      name: "Forks",
      description: "fork a background sleep",
      parameters: { type: "object", properties: {} },
      handler: { type: "script", path: "scripts/forks", argTemplate: "x", timeoutMs },
    } as unknown as ToolSpec
    return toolSpecToHandler(spec, dir, { env: { PATH: process.env.PATH } }) as {
      invoke: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
  }

  async function readPids(): Promise<number[]> {
    const file = join(dir, "pids")
    const end = Date.now() + 2000
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

  test("timeout kills the script and its background child", async () => {
    // 500 ms is about 40 times the start of the warmed script.
    const run = handler(500).invoke({ trigger: { type: "tool", input: {} } })
    const [script, bg] = await readPids()
    const r = await within(run, 3000)
    expect(r.is_error).toBe(true)
    expect(await waitGone(script, 1000)).toBe(true)
    expect(await waitGone(bg, 1000)).toBe(true)
  })

  test("abort kills the script and its background child", async () => {
    const ac = new AbortController()
    const run = handler(30_000).invoke({ trigger: { type: "tool", input: {} }, abort: ac.signal })
    const [script, bg] = await readPids()
    ac.abort()
    const r = await within(run, 3000)
    expect(r.is_error).toBe(true)
    expect(await waitGone(script, 1000)).toBe(true)
    expect(await waitGone(bg, 1000)).toBe(true)
  })
})
