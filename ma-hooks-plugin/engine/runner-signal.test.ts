/**
 * Real-signal tests for the hook group cleanup (B2 review BLOCKER, MAJOR 1
 * and MAJOR 2). Each case runs `runner-signal.fixture.ts` in a child bun
 * process and sends a real signal to that child only. The test process never
 * gets a signal.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { makeSandbox, type Sandbox } from "./test-support.ts"

const FIXTURE = join(import.meta.dir, "runner-signal.fixture.ts")

let sb: Sandbox
/** Every pid a test started or saw, killed by exact pid. */
let pids: number[] = []

beforeEach(() => {
  sb = makeSandbox()
})

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  pids = []
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

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) return false
    await Bun.sleep(20)
  }
  return true
}

interface Outcome {
  readonly exitedInTime: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  readonly lines: string[]
  readonly grandchildGone: boolean
}

async function runCase(mode: string, sig: NodeJS.Signals): Promise<Outcome> {
  const pidFile = join(sb.root, "grandchild.pid")
  const script = sb.script("hang.sh", `sleep 60 &\necho $! > ${pidFile}\nwait`)
  const proc = Bun.spawn(["bun", "run", FIXTURE, mode, script, pidFile], {
    cwd: sb.project,
    env: sb.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  pids.push(proc.pid)
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("ready\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  expect(existsSync(pidFile)).toBe(true)
  const grandchild = Number(readFileSync(pidFile, "utf8").trim())
  pids.push(grandchild)
  expect(alive(grandchild)).toBe(true)
  proc.kill(sig)
  const exitedInTime = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(8000).then(() => false),
  ])
  if (exitedInTime) {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value)
    }
  }
  const grandchildGone = await waitFor(() => !alive(grandchild))
  return {
    exitedInTime,
    exitCode: exitedInTime ? proc.exitCode : null,
    signal: exitedInTime && proc.signalCode ? String(proc.signalCode) : null,
    lines: text.split("\n").filter((l) => l !== ""),
    grandchildGone,
  }
}

/** True when the child ended by `sig` (signal, or the 128+n exit code). */
function endedBy(o: Outcome, sig: NodeJS.Signals, code: number): boolean {
  return o.signal === sig || o.exitCode === code
}

describe("runner: real signals end the host and kill hook groups", () => {
  test("alone, SIGTERM: child exits by signal, grandchild gone", async () => {
    const o = await runCase("alone", "SIGTERM")
    expect(o.exitedInTime).toBe(true)
    expect(endedBy(o, "SIGTERM", 143)).toBe(true)
    expect(o.grandchildGone).toBe(true)
  }, 20000)

  test("alone, SIGHUP: child exits by signal, grandchild gone", async () => {
    const o = await runCase("alone", "SIGHUP")
    expect(o.exitedInTime).toBe(true)
    expect(endedBy(o, "SIGHUP", 129)).toBe(true)
    expect(o.grandchildGone).toBe(true)
  }, 20000)

  test("with a tagged fan-out listener, SIGTERM: child still exits by signal, grandchild gone", async () => {
    const o = await runCase("fanout", "SIGTERM")
    expect(o.exitedInTime).toBe(true)
    expect(endedBy(o, "SIGTERM", 143)).toBe(true)
    expect(o.lines).toContain("fanout SIGTERM")
    expect(o.grandchildGone).toBe(true)
  }, 20000)

  test("with an untagged host listener, SIGTERM: host owns it, fixture exits 0, grandchild gone", async () => {
    const o = await runCase("host", "SIGTERM")
    expect(o.exitedInTime).toBe(true)
    expect(o.signal).toBeNull()
    expect(o.exitCode).toBe(0)
    expect(o.lines).toContain("host")
    expect(o.lines).toContain("run-done")
    expect(o.grandchildGone).toBe(true)
  }, 20000)
})
