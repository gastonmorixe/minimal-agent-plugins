import { describe, expect, test } from "bun:test"

import {
  buildJobArgv,
  ENV,
  exitedSidecar,
  parseRunnerEnv,
  runningSidecar,
  type SidecarBase,
  stoppedSidecar,
  timedoutSidecar,
} from "./runner-core.ts"

function fullEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [ENV.JOB_ID]: "j1",
    [ENV.COMMAND]: "echo hi",
    [ENV.CWD]: "/tmp",
    [ENV.LOG_PATH]: "/tmp/j1.log",
    [ENV.STATUS_PATH]: "/tmp/j1.status.json",
    [ENV.TIMEOUT_MS]: "600000",
    ...over,
  }
}

describe("parseRunnerEnv", () => {
  test("valid env", () => {
    const r = parseRunnerEnv(fullEnv())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        jobId: "j1",
        command: "echo hi",
        cwd: "/tmp",
        logPath: "/tmp/j1.log",
        statusPath: "/tmp/j1.status.json",
        timeoutMs: 600_000,
      })
    }
  })

  test("missing required fields fail", () => {
    for (const key of [ENV.JOB_ID, ENV.COMMAND, ENV.CWD, ENV.LOG_PATH, ENV.STATUS_PATH]) {
      const r = parseRunnerEnv(fullEnv({ [key]: undefined }))
      expect(r.ok).toBe(false)
    }
  })

  test("empty command rejected", () => {
    expect(parseRunnerEnv(fullEnv({ [ENV.COMMAND]: "" })).ok).toBe(false)
  })

  test("timeout defaults to 0 when absent", () => {
    const r = parseRunnerEnv(fullEnv({ [ENV.TIMEOUT_MS]: undefined }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.timeoutMs).toBe(0)
  })

  test("bad timeout rejected", () => {
    expect(parseRunnerEnv(fullEnv({ [ENV.TIMEOUT_MS]: "soon" })).ok).toBe(false)
    expect(parseRunnerEnv(fullEnv({ [ENV.TIMEOUT_MS]: "-5" })).ok).toBe(false)
  })
})

describe("buildJobArgv", () => {
  test("wraps in bash -c", () => {
    expect(buildJobArgv("ls -la")).toEqual(["bash", "-c", "ls -la"])
  })
})

describe("sidecar builders", () => {
  const base: SidecarBase = { jobId: "j1", startedAt: "t0", jobPid: 42 }

  test("running", () => {
    expect(runningSidecar(base)).toEqual({
      v: 1,
      id: "j1",
      phase: "running",
      startedAt: "t0",
      jobPid: 42,
    })
  })

  test("exited with code", () => {
    expect(exitedSidecar(base, "t1", { exitCode: 0 })).toEqual({
      v: 1,
      id: "j1",
      phase: "exited",
      startedAt: "t0",
      jobPid: 42,
      endedAt: "t1",
      exitCode: 0,
    })
  })

  test("exited with signal", () => {
    const s = exitedSidecar(base, "t1", { signal: "SIGSEGV" })
    expect(s.phase).toBe("exited")
    expect(s.signal).toBe("SIGSEGV")
    expect(s.exitCode).toBeUndefined()
  })

  test("timedout", () => {
    const s = timedoutSidecar(base, "t1", 5000)
    expect(s).toMatchObject({ phase: "timedout", timeoutMs: 5000, endedAt: "t1" })
  })

  test("stopped", () => {
    const s = stoppedSidecar(base, "t1", "harness exited")
    expect(s).toMatchObject({ phase: "stopped", reason: "harness exited" })
  })

  test("omits jobPid when absent", () => {
    const s = runningSidecar({ jobId: "j1", startedAt: "t0" })
    expect("jobPid" in s).toBe(false)
  })
})
