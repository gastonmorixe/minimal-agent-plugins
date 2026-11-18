/**
 * Tests for the web-search plugin's config loader.
 *
 * Covers: defaults, full happy-path, partial overrides, malformed values
 * (dropped silently), `enabled` toggle, provider-config blocks under
 * `plugins["web-search"].<id>`, missing file → defaults.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { defaultConfig, loadWebSearchConfig, parseWebSearchConfig } from "./config.ts"

describe("parseWebSearchConfig", () => {
  test("non-object input → defaults", () => {
    expect(parseWebSearchConfig(null)).toEqual(defaultConfig())
    expect(parseWebSearchConfig(42)).toEqual(defaultConfig())
    expect(parseWebSearchConfig([])).toEqual(defaultConfig())
  })

  test('missing plugins["web-search"] → defaults', () => {
    expect(parseWebSearchConfig({})).toEqual(defaultConfig())
    expect(parseWebSearchConfig({ plugins: {} })).toEqual(defaultConfig())
    expect(parseWebSearchConfig({ plugins: { other: {} } })).toEqual(defaultConfig())
    expect(parseWebSearchConfig({ plugins: { websearch: { enabled: false } } })).toEqual(
      defaultConfig(),
    )
  })

  test("happy-path full config", () => {
    const cfg = parseWebSearchConfig({
      plugins: {
        "web-search": {
          enabled: true,
          providers: ["brave", "tavily"],
          defaults: { count: 5, safesearch: "off", country: "US", lang: "en", type: "news" },
          brave: { apiKeyEnv: "BRAVE_API_KEY" },
          tavily: { apiKey: "secret" },
        },
      },
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.providers).toEqual(["brave", "tavily"])
    expect(cfg.defaults.count).toBe(5)
    expect(cfg.defaults.safesearch).toBe("off")
    expect(cfg.defaults.type).toBe("news")
    expect(cfg.providerConfigs.brave).toEqual({ apiKeyEnv: "BRAVE_API_KEY" })
    expect(cfg.providerConfigs.tavily).toEqual({ apiKey: "secret" })
  })

  test("disabled flag", () => {
    const cfg = parseWebSearchConfig({ plugins: { "web-search": { enabled: false } } })
    expect(cfg.enabled).toBe(false)
  })

  test("invalid types are dropped silently", () => {
    const cfg = parseWebSearchConfig({
      plugins: {
        "web-search": {
          providers: [42, "brave", null, ""],
          defaults: { count: -1, safesearch: "yolo", country: 123, type: "videos" },
          brave: "not-an-object",
        },
      },
    })
    expect(cfg.providers).toEqual(["brave"]) // non-strings dropped
    expect(cfg.defaults.count).toBe(10) // default kept
    expect(cfg.defaults.safesearch).toBe("moderate") // invalid enum dropped
    expect(cfg.defaults.country).toBe("ALL") // wrong type dropped
    expect(cfg.defaults.type).toBeUndefined() // unsupported vertical dropped
    // brave block was a string, so the default config block is kept.
    expect(cfg.providerConfigs.brave).toEqual({ apiKeyEnv: "BRAVE_API_KEY" })
  })

  test("partial defaults merge with built-ins", () => {
    const cfg = parseWebSearchConfig({
      plugins: { "web-search": { defaults: { count: 3 } } },
    })
    expect(cfg.defaults.count).toBe(3)
    expect(cfg.defaults.safesearch).toBe("moderate") // built-in survives
    expect(cfg.defaults.country).toBe("ALL")
  })

  test("empty providers array → defaults survive", () => {
    const cfg = parseWebSearchConfig({
      plugins: { "web-search": { providers: [] } },
    })
    expect(cfg.providers).toEqual(["brave"])
  })
})

describe("loadWebSearchConfig", () => {
  let tmpDir: string
  let prevConfigEnv: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ws-cfg-"))
    prevConfigEnv = process.env.MINIMAL_AGENT_CONFIG
  })

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevConfigEnv
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("missing file → defaults", () => {
    process.env.MINIMAL_AGENT_CONFIG = join(tmpDir, "nope.jsonc")
    expect(loadWebSearchConfig()).toEqual(defaultConfig())
  })

  test("reads jsonc with comments + trailing commas", () => {
    const path = join(tmpDir, "config.jsonc")
    writeFileSync(
      path,
      `{
        // model is unrelated; we only care about plugins["web-search"]
        "model": "claude-opus-4-7",
        "plugins": {
          "web-search": {
            "providers": ["brave"],
            "defaults": { "count": 3, },
            "brave": { "apiKey": "inline-key" },
          },
        },
      }`,
    )
    process.env.MINIMAL_AGENT_CONFIG = path
    const cfg = loadWebSearchConfig()
    expect(cfg.providers).toEqual(["brave"])
    expect(cfg.defaults.count).toBe(3)
    expect(cfg.providerConfigs.brave).toEqual({ apiKey: "inline-key" })
  })

  test("malformed jsonc → defaults (no throw)", () => {
    const path = join(tmpDir, "bad.jsonc")
    writeFileSync(path, "{ not valid")
    process.env.MINIMAL_AGENT_CONFIG = path
    expect(loadWebSearchConfig()).toEqual(defaultConfig())
  })
})

describe("loadWebSearchConfig - malformed config file", () => {
  let dir: string
  let savedConfig: string | undefined
  let savedDebug: string | undefined

  // Each test writes its own file, so the once-per-process report never leaks
  // from one test into the next.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-cfg-warn-"))
    savedConfig = process.env.MINIMAL_AGENT_CONFIG
    savedDebug = process.env.DEBUG
  })

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = savedConfig
    if (savedDebug === undefined) delete process.env.DEBUG
    else process.env.DEBUG = savedDebug
    rmSync(dir, { recursive: true, force: true })
  })

  function badFile(): string {
    const path = join(dir, "bad.jsonc")
    writeFileSync(path, "{ not valid")
    process.env.MINIMAL_AGENT_CONFIG = path
    return path
  }

  test("reports through onWarn once with { path } when loaded three times, and writes no stderr with DEBUG=1", () => {
    const path = badFile()
    process.env.DEBUG = "1"
    const calls: Array<{ message: string; data: unknown }> = []
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      for (let i = 0; i < 3; i++) {
        const cfg = loadWebSearchConfig((message, data) => calls.push({ message, data }))
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
    badFile()
    process.env.DEBUG = "1"
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(loadWebSearchConfig()).toEqual(defaultConfig())
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  test("a load without a callback does not use up the report for a later one", () => {
    const path = badFile()
    loadWebSearchConfig()
    const calls: unknown[] = []
    loadWebSearchConfig((_message, data) => calls.push(data))
    expect(calls).toEqual([{ path }])
  })

  test("a callback that throws does not break the load", () => {
    badFile()
    expect(
      loadWebSearchConfig(() => {
        throw new Error("sink down")
      }),
    ).toEqual(defaultConfig())
  })
})
