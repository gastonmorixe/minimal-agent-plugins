import { describe, expect, test } from "bun:test"

import { RUNNER_SCRIPT_ID, resolveRunnerArgv, runnerPathFor } from "./handler-deps.ts"

const PKG = "/plugins/ma-background-plugin"
const RUNNER = "/plugins/ma-background-plugin/bin/runner.ts"

describe("runnerPathFor", () => {
  test("bin/runner.ts inside the package", () => {
    expect(runnerPathFor(PKG)).toBe(RUNNER)
  })
})

describe("resolveRunnerArgv", () => {
  test("the script id matches the manifest scripts key (<plugin-id>/<name>)", async () => {
    const manifest = (await import("../manifest.json")).default as {
      id: string
      scripts: Record<string, string>
    }
    expect(RUNNER_SCRIPT_ID).toBe(`${manifest.id}/runner`)
    expect(manifest.scripts.runner).toBe("./bin/runner.ts")
  })

  test("source run: [bun, <pkg>/bin/runner.ts]", () => {
    expect(resolveRunnerArgv(PKG, {}, { execPath: "/usr/bin/bun", standalone: false })).toEqual([
      "/usr/bin/bun",
      RUNNER,
    ])
  })

  test("compiled: [<binary>, __run, ma-bg/runner], never the .ts path", () => {
    expect(
      resolveRunnerArgv(PKG, {}, { execPath: "/usr/local/bin/minimal-agent", standalone: true }),
    ).toEqual(["/usr/local/bin/minimal-agent", "__run", "ma-bg/runner"])
  })

  test("MINIMAL_AGENT_BG_RUNTIME wins in both modes, followed by the runner path", () => {
    const env = { MINIMAL_AGENT_BG_RUNTIME: " /opt/bun  run " }
    for (const standalone of [false, true]) {
      expect(resolveRunnerArgv(PKG, env, { execPath: "/x", standalone })).toEqual([
        "/opt/bun",
        "run",
        RUNNER,
      ])
    }
  })

  test("a blank override is ignored", () => {
    expect(
      resolveRunnerArgv(
        PKG,
        { MINIMAL_AGENT_BG_RUNTIME: "  " },
        { execPath: "/b", standalone: false },
      ),
    ).toEqual(["/b", RUNNER])
  })

  test("defaults to this process: bun + the runner path from source", () => {
    expect(resolveRunnerArgv(PKG, {})).toEqual([process.execPath, RUNNER])
  })
})
