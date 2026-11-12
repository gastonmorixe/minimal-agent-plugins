import { describe, expect, test } from "bun:test"

import manifest from "../manifest.json"

import {
  daemonEnv,
  SERVER_PROCESS_PATTERN,
  SERVER_SCRIPT_ID,
  serverArgv,
  serverPathFor,
} from "./daemon-spawn.ts"

describe("serverArgv", () => {
  test("source run: [execPath, <pkg>/bin/cdp-server.ts], no PATH bun", () => {
    expect(serverArgv("/pkg", { execPath: "/usr/bin/bun", standalone: false })).toEqual([
      "/usr/bin/bun",
      "/pkg/bin/cdp-server.ts",
    ])
  })

  test("compiled: [<binary>, __run, ma-chrome-cdp/cdp-server]", () => {
    expect(serverArgv("/$bunfs/root", { execPath: "/opt/ma", standalone: true })).toEqual([
      "/opt/ma",
      "__run",
      "ma-chrome-cdp/cdp-server",
    ])
  })

  test("the script id matches the manifest scripts map", () => {
    const m = manifest as { id: string; scripts: Record<string, string> }
    expect(SERVER_SCRIPT_ID).toBe(`${m.id}/cdp-server`)
    expect(m.scripts["cdp-server"]).toBe("./bin/cdp-server.ts")
    expect(serverPathFor("/pkg")).toBe("/pkg/bin/cdp-server.ts")
  })
})

describe("daemonEnv", () => {
  test("strips BUN_BE_BUN and undefined values", () => {
    expect(daemonEnv({ PATH: "/bin", BUN_BE_BUN: "1", X: undefined })).toEqual({ PATH: "/bin" })
  })
})

describe("SERVER_PROCESS_PATTERN", () => {
  const re = new RegExp(SERVER_PROCESS_PATTERN)
  test("matches the daemon command line in both run modes", () => {
    expect(re.test("/usr/bin/bun /pkg/bin/cdp-server.ts")).toBe(true)
    expect(re.test("/opt/ma __run ma-chrome-cdp/cdp-server")).toBe(true)
  })
  test("does not match the log tail or the control CLI", () => {
    expect(re.test("tail -n 40 /tmp/cdp-server.log")).toBe(false)
    expect(re.test("/opt/ma __run ma-chrome-cdp/cdpd status")).toBe(false)
  })
})
