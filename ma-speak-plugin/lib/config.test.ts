import { describe, expect, test } from "bun:test"

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_WAIT_TIMEOUT_SEC,
  defaultConfig,
  MAX_CHARS_CEILING,
  MAX_CHARS_FLOOR,
  parseSpeakConfig,
  WAIT_TIMEOUT_CEILING_SEC,
} from "./config.ts"

describe("defaultConfig", () => {
  test("returns sensible built-in defaults", () => {
    const c = defaultConfig()
    expect(c.enabled).toBe(true)
    expect(c.backend).toBe("macos-say")
    expect(c.backends).toEqual({})
    expect(c.defaults.maxChars).toBe(DEFAULT_MAX_CHARS)
    expect(c.defaults.waitTimeoutSec).toBe(DEFAULT_WAIT_TIMEOUT_SEC)
  })

  test("is a fresh object each call (no shared mutable state)", () => {
    const a = defaultConfig()
    a.backends.foo = { bin: "x" }
    expect(defaultConfig().backends).toEqual({})
  })
})

describe("parseSpeakConfig - falls back to defaults on bad input", () => {
  test("null / undefined / non-object", () => {
    expect(parseSpeakConfig(null)).toEqual(defaultConfig())
    expect(parseSpeakConfig(undefined)).toEqual(defaultConfig())
    expect(parseSpeakConfig(42)).toEqual(defaultConfig())
    expect(parseSpeakConfig("string")).toEqual(defaultConfig())
    expect(parseSpeakConfig([])).toEqual(defaultConfig())
  })

  test("missing plugins block", () => {
    expect(parseSpeakConfig({})).toEqual(defaultConfig())
    expect(parseSpeakConfig({ plugins: null })).toEqual(defaultConfig())
    expect(parseSpeakConfig({ plugins: "wrong" })).toEqual(defaultConfig())
  })

  test("missing plugins['ma-speak'] block", () => {
    expect(parseSpeakConfig({ plugins: {} })).toEqual(defaultConfig())
    expect(parseSpeakConfig({ plugins: { "other-plugin": {} } })).toEqual(defaultConfig())
  })
})

describe("parseSpeakConfig - enabled", () => {
  test("honors boolean enabled=false", () => {
    expect(parseSpeakConfig({ plugins: { "ma-speak": { enabled: false } } }).enabled).toBe(false)
  })

  test("ignores non-boolean enabled", () => {
    expect(parseSpeakConfig({ plugins: { "ma-speak": { enabled: "no" } } }).enabled).toBe(true)
  })
})

describe("parseSpeakConfig - backend", () => {
  test("accepts a safe backend id", () => {
    expect(parseSpeakConfig({ plugins: { "ma-speak": { backend: "macos-say" } } }).backend).toBe(
      "macos-say",
    )
    expect(parseSpeakConfig({ plugins: { "ma-speak": { backend: "elevenlabs2" } } }).backend).toBe(
      "elevenlabs2",
    )
  })

  test("rejects path-traversal / unsafe backend ids (keeps default)", () => {
    for (const bad of ["../evil", "a/b", "a;b", "..", "", "  "]) {
      expect(parseSpeakConfig({ plugins: { "ma-speak": { backend: bad } } }).backend).toBe(
        "macos-say",
      )
    }
  })
})

describe("parseSpeakConfig - defaults", () => {
  test("honors maxChars and waitTimeoutSec", () => {
    const c = parseSpeakConfig({
      plugins: { "ma-speak": { defaults: { maxChars: 1234, waitTimeoutSec: 45 } } },
    })
    expect(c.defaults.maxChars).toBe(1234)
    expect(c.defaults.waitTimeoutSec).toBe(45)
  })

  test("clamps maxChars to [floor, ceiling]", () => {
    expect(
      parseSpeakConfig({ plugins: { "ma-speak": { defaults: { maxChars: -10 } } } }).defaults
        .maxChars,
    ).toBe(MAX_CHARS_FLOOR)
    expect(
      parseSpeakConfig({ plugins: { "ma-speak": { defaults: { maxChars: 9_999_999 } } } }).defaults
        .maxChars,
    ).toBe(MAX_CHARS_CEILING)
  })

  test("clamps waitTimeoutSec to ceiling", () => {
    expect(
      parseSpeakConfig({ plugins: { "ma-speak": { defaults: { waitTimeoutSec: 99_999 } } } })
        .defaults.waitTimeoutSec,
    ).toBe(WAIT_TIMEOUT_CEILING_SEC)
  })

  test("floors fractional values", () => {
    expect(
      parseSpeakConfig({ plugins: { "ma-speak": { defaults: { maxChars: 100.9 } } } }).defaults
        .maxChars,
    ).toBe(100)
  })

  test("ignores non-numeric defaults", () => {
    const c = parseSpeakConfig({
      plugins: { "ma-speak": { defaults: { maxChars: "big", waitTimeoutSec: null } } },
    })
    expect(c.defaults.maxChars).toBe(DEFAULT_MAX_CHARS)
    expect(c.defaults.waitTimeoutSec).toBe(DEFAULT_WAIT_TIMEOUT_SEC)
  })
})

describe("parseSpeakConfig - per-backend blocks", () => {
  test("captures bin / voice / rate for a backend block", () => {
    const c = parseSpeakConfig({
      plugins: {
        "ma-speak": {
          "macos-say": { bin: "/usr/bin/say", voice: "Samantha", rate: 180 },
        },
      },
    })
    expect(c.backends["macos-say"]).toEqual({ bin: "/usr/bin/say", voice: "Samantha", rate: 180 })
  })

  test("trims strings and floors rate", () => {
    const c = parseSpeakConfig({
      plugins: { "ma-speak": { "macos-say": { voice: "  Alex  ", rate: 200.7 } } },
    })
    expect(c.backends["macos-say"]).toEqual({ voice: "Alex", rate: 200 })
  })

  test("drops empty / wrong-type / non-positive fields", () => {
    const c = parseSpeakConfig({
      plugins: {
        "ma-speak": { "macos-say": { bin: "  ", voice: 42, rate: -5 } },
      },
    })
    expect(c.backends["macos-say"]).toEqual({})
  })

  test("known top-level keys are not treated as backend blocks", () => {
    const c = parseSpeakConfig({
      plugins: { "ma-speak": { enabled: true, backend: "macos-say", defaults: { maxChars: 10 } } },
    })
    expect(c.backends).toEqual({})
  })
})
