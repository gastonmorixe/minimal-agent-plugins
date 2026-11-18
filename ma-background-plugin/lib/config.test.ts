import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import {
  DEFAULT_MAX_MODEL_BYTES,
  DEFAULT_TIMEOUT_MS,
  defaultConfig,
  loadBgConfig,
  MAX_CONCURRENT_CEILING,
  parseBgConfig,
} from "./config.ts"
import { INFINITE_MS, ONE_DAY_MS } from "./duration.ts"

describe("defaultConfig", () => {
  test("sane defaults", () => {
    const c = defaultConfig()
    expect(c.enabled).toBe(true)
    expect(c.defaults.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(c.defaults.maxTimeoutMs).toBe(ONE_DAY_MS)
    expect(c.defaults.allowInfinite).toBe(false)
    expect(c.limits.maxConcurrent).toBe(16)
    expect(c.limits.maxTotal).toBe(128)
    expect(c.log.maxModelBytes).toBe(DEFAULT_MAX_MODEL_BYTES)
  })
})

describe("parseBgConfig", () => {
  test("non-object -> defaults", () => {
    expect(parseBgConfig(null)).toEqual(defaultConfig())
    expect(parseBgConfig(42)).toEqual(defaultConfig())
    expect(parseBgConfig("nope")).toEqual(defaultConfig())
  })

  test("missing plugins section -> defaults", () => {
    expect(parseBgConfig({ other: 1 })).toEqual(defaultConfig())
  })

  test("missing ma-bg block -> defaults", () => {
    expect(parseBgConfig({ plugins: { "ma-speak": {} } })).toEqual(defaultConfig())
  })

  test("enabled false is honored", () => {
    const c = parseBgConfig({ plugins: { "ma-bg": { enabled: false } } })
    expect(c.enabled).toBe(false)
  })

  test("timeout strings parse", () => {
    const c = parseBgConfig({ plugins: { "ma-bg": { defaults: { timeout: "30m" } } } })
    expect(c.defaults.timeoutMs).toBe(1_800_000)
  })

  test("maxTimeout clamps default timeout", () => {
    const c = parseBgConfig({
      plugins: { "ma-bg": { defaults: { timeout: "10h", maxTimeout: "2h" } } },
    })
    expect(c.defaults.maxTimeoutMs).toBe(7_200_000)
    expect(c.defaults.timeoutMs).toBe(7_200_000) // clamped down
  })

  test("allowInfinite gate lets infinite default through", () => {
    const c = parseBgConfig({
      plugins: { "ma-bg": { defaults: { timeout: "infinite", allowInfinite: true } } },
    })
    expect(c.defaults.allowInfinite).toBe(true)
    expect(c.defaults.timeoutMs).toBe(INFINITE_MS)
  })

  test("infinite default ignored when not allowed", () => {
    const c = parseBgConfig({
      plugins: { "ma-bg": { defaults: { timeout: "infinite" } } },
    })
    // falls back to the built-in default ms, then clamped under max
    expect(c.defaults.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  test("limits clamp to ceilings", () => {
    const c = parseBgConfig({
      plugins: { "ma-bg": { limits: { maxConcurrent: 99999, maxTotal: 0 } } },
    })
    expect(c.defaults.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(c.limits.maxConcurrent).toBe(MAX_CONCURRENT_CEILING)
    expect(c.limits.maxTotal).toBe(1) // floored to 1
  })

  test("log.maxModelBytes clamps", () => {
    const lo = parseBgConfig({ plugins: { "ma-bg": { log: { maxModelBytes: 1 } } } })
    expect(lo.log.maxModelBytes).toBe(1024)
    const hi = parseBgConfig({ plugins: { "ma-bg": { log: { maxModelBytes: 9_999_999 } } } })
    expect(hi.log.maxModelBytes).toBe(1_048_576)
  })

  test("wrong types are ignored", () => {
    const c = parseBgConfig({
      plugins: { "ma-bg": { enabled: "yes", limits: { maxConcurrent: "lots" } } },
    })
    expect(c.enabled).toBe(true)
    expect(c.limits.maxConcurrent).toBe(16)
  })
})

describe("loadBgConfig - malformed config file", () => {
  let dir: string
  let savedDebug: string | undefined

  // Each test writes its own file, so the once-per-process report never leaks
  // from one test into the next.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-bg-cfg-"))
    savedDebug = process.env.DEBUG
  })

  afterEach(() => {
    if (savedDebug === undefined) delete process.env.DEBUG
    else process.env.DEBUG = savedDebug
    rmSync(dir, { recursive: true, force: true })
  })

  /** An env that points the loader at a malformed file; DEBUG=1 on purpose. */
  function badEnv(): { env: NodeJS.ProcessEnv; path: string } {
    const path = join(dir, "bad.jsonc")
    writeFileSync(path, "{ not valid")
    return { env: { MINIMAL_AGENT_CONFIG: path, DEBUG: "1" }, path }
  }

  test("reports through onWarn once with { path } when loaded three times, and writes no stderr with DEBUG=1", () => {
    const { env, path } = badEnv()
    process.env.DEBUG = "1"
    const calls: Array<{ message: string; data: unknown }> = []
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      // The heartbeat slot reloads the config every second: three loads, one report.
      for (let i = 0; i < 3; i++) {
        const cfg = loadBgConfig(env, (message, data) => calls.push({ message, data }))
        expect(cfg).toEqual(defaultConfig())
      }
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data).toEqual({ path })
    expect(calls[0]?.message).toStartWith("parse error: ")
  })

  test("is silent without a callback, even with DEBUG=1", () => {
    const { env } = badEnv()
    process.env.DEBUG = "1"
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(loadBgConfig(env)).toEqual(defaultConfig())
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  test("a load without a callback does not use up the report for a later one", () => {
    const { env, path } = badEnv()
    loadBgConfig(env)
    const calls: unknown[] = []
    loadBgConfig(env, (_message, data) => calls.push(data))
    expect(calls).toEqual([{ path }])
  })

  test("a callback that throws does not break the load", () => {
    const { env } = badEnv()
    expect(
      loadBgConfig(env, () => {
        throw new Error("sink down")
      }),
    ).toEqual(defaultConfig())
  })
})
