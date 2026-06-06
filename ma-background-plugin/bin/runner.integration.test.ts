/**
 * End-to-end tests for the runner executable. These spawn the real
 * `bin/runner.ts` (no fakes) and assert on the log + sidecar it produces,
 * including the load-bearing cleanup behavior: killing the runner kills the
 * job, and CLOSING THE RUNNER'S STDIN (the harness-death signal) does too.
 *
 * Kept fast: each job is sub-second. Marked integration so it stays alongside
 * the unit suite but exercises the real OS path.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { ENV } from "../lib/runner-core.ts"
import { parseSidecar, type Sidecar } from "../lib/sidecar.ts"

const RUNNER = join(import.meta.dir, "runner.ts")

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bgrunner-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface SpawnOpts {
  command: string
  timeoutMs?: number
  stdin?: "pipe" | "ignore"
}

function spawnRunner(opts: SpawnOpts) {
  const logPath = join(dir, "j1.log")
  const statusPath = join(dir, "j1.status.json")
  const proc = Bun.spawn(["bun", "run", RUNNER], {
    env: {
      ...process.env,
      [ENV.JOB_ID]: "j1",
      [ENV.COMMAND]: opts.command,
      [ENV.CWD]: dir,
      [ENV.LOG_PATH]: logPath,
      [ENV.STATUS_PATH]: statusPath,
      [ENV.TIMEOUT_MS]: String(opts.timeoutMs ?? 0),
    },
    stdin: opts.stdin ?? "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  return { proc, logPath, statusPath }
}

function readSidecar(path: string): Sidecar | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parseSidecar(JSON.parse(readFileSync(path, "utf-8")))
  } catch {
    return undefined
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await Bun.sleep(50)
  }
  return pred()
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("runner: normal completion", () => {
  test("captures output and writes an exited sidecar", async () => {
    const { proc, logPath, statusPath } = spawnRunner({ command: "echo hello-world" })
    await proc.exited
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("hello-world")
    const s = readSidecar(statusPath)
    expect(s?.phase).toBe("exited")
    expect(s?.exitCode).toBe(0)
  })

  test("records a non-zero exit code", async () => {
    const { proc, statusPath } = spawnRunner({ command: "exit 3" })
    await proc.exited
    const s = readSidecar(statusPath)
    expect(s?.phase).toBe("exited")
    expect(s?.exitCode).toBe(3)
  })

  test("preserves ANSI bytes in the raw log", async () => {
    const { proc, logPath } = spawnRunner({
      command: "printf '\\033[31mRED\\033[0m\\n'",
    })
    await proc.exited
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("\x1b[31m")
  })
})

describe("runner: timeout", () => {
  test("kills a long job and writes a timedout sidecar", async () => {
    const { proc, statusPath } = spawnRunner({ command: "sleep 30", timeoutMs: 400 })
    await proc.exited
    const s = readSidecar(statusPath)
    expect(s?.phase).toBe("timedout")
    expect(s?.timeoutMs).toBe(400)
  }, 10000)
})

describe("runner: explicit stop", () => {
  test("SIGTERM stops the job and records stopped", async () => {
    const { proc, statusPath } = spawnRunner({ command: "sleep 30" })
    await waitFor(() => readSidecar(statusPath)?.phase === "running")
    proc.kill("SIGTERM")
    await proc.exited
    const s = readSidecar(statusPath)
    expect(s?.phase).toBe("stopped")
  }, 10000)
})

describe("runner: harness-death via stdin EOF (the hard requirement)", () => {
  test("closing the runner's stdin kills the job and its grandchild", async () => {
    // A job that forks a grandchild touching a marker file. If cleanup works,
    // the marker stops being updated once the runner tears the group down.
    const marker = join(dir, "alive")
    const command = `bash -c 'while true; do touch ${marker}; sleep 0.2; done' & echo $! > ${join(dir, "gcpid")}; wait`
    const { proc, statusPath } = spawnRunner({ command })
    await waitFor(() => readSidecar(statusPath)?.phase === "running")
    await waitFor(() => existsSync(join(dir, "gcpid")))
    const gcPid = Number(readFileSync(join(dir, "gcpid"), "utf-8").trim())
    expect(gcPid).toBeGreaterThan(0)

    // Simulate harness death: close the runner's stdin write-end. We do that by
    // ending the FileSink Bun handed us for the runner's stdin.
    const sink = proc.stdin
    if (sink && typeof sink !== "number") void sink.end()

    // The runner should exit shortly after EOF.
    await proc.exited
    const s = readSidecar(statusPath)
    expect(s?.phase).toBe("stopped")
    expect(s?.reason).toContain("harness")

    // The grandchild must be dead (group-killed). Give the escalation a beat.
    const dead = await waitFor(() => !pidAlive(gcPid), 4000)
    expect(dead).toBe(true)
  }, 15000)
})
