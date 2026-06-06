import { describe, expect, test } from "bun:test"

import { ENV } from "./runner-core.ts"
import { buildRunnerArgv, buildRunnerEnv, type LaunchSpec, launchRunner } from "./spawn.ts"

function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    runnerPath: "/pkg/bin/runner.ts",
    runtime: ["bun", "run"],
    jobId: "j1",
    command: "echo hi",
    cwd: "/work",
    logPath: "/s/sid.bgjobs/j1.log",
    statusPath: "/s/sid.bgjobs/j1.status.json",
    timeoutMs: 600_000,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/me", UNDEF: undefined },
    ...over,
  }
}

describe("buildRunnerEnv", () => {
  test("carries base env and stamps the MA_BG contract", () => {
    const env = buildRunnerEnv(spec())
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/me")
    expect("UNDEF" in env).toBe(false) // undefined dropped
    expect(env[ENV.JOB_ID]).toBe("j1")
    expect(env[ENV.COMMAND]).toBe("echo hi")
    expect(env[ENV.CWD]).toBe("/work")
    expect(env[ENV.LOG_PATH]).toBe("/s/sid.bgjobs/j1.log")
    expect(env[ENV.STATUS_PATH]).toBe("/s/sid.bgjobs/j1.status.json")
    expect(env[ENV.TIMEOUT_MS]).toBe("600000")
  })
})

describe("buildRunnerArgv", () => {
  test("runtime then runner path", () => {
    expect(buildRunnerArgv(spec())).toEqual(["bun", "run", "/pkg/bin/runner.ts"])
  })
  test("single-element runtime", () => {
    expect(buildRunnerArgv(spec({ runtime: ["/usr/local/bin/bun"] }))).toEqual([
      "/usr/local/bin/bun",
      "/pkg/bin/runner.ts",
    ])
  })
})

describe("launchRunner", () => {
  test("ok wraps the handle", () => {
    const r = launchRunner(spec(), (s) => ({
      pid: 4242,
      closeStdin: () => {},
      _spec: s,
    }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.pid).toBe(4242)
  })

  test("a throwing launcher becomes a typed error", () => {
    const r = launchRunner(spec(), () => {
      throw new Error("ENOENT bun")
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("ENOENT bun")
  })
})
