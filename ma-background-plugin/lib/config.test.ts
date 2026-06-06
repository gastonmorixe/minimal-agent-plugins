import { describe, expect, test } from "bun:test"

import {
  DEFAULT_MAX_MODEL_BYTES,
  DEFAULT_TIMEOUT_MS,
  defaultConfig,
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
