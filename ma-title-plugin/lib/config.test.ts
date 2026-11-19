import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  clearTitleConfigCache,
  DEFAULT_ON_MODES,
  defaultTitleConfig,
  loadTitleConfig,
  parseTitleConfig,
  readTitleEnv,
  resolveModelOverride,
  resolveTitleSwitch,
  titleConfigPath,
} from "./config.ts"

function wrap(block: unknown): unknown {
  return { plugins: { title: block } }
}

describe("parseTitleConfig", () => {
  test("defaults (P1b: default ON in repl only, no modes set)", () => {
    const c = parseTitleConfig({})
    expect(c).toEqual(defaultTitleConfig())
    expect(c.modes).toBeUndefined()
    expect(DEFAULT_ON_MODES).toEqual(["repl"])
    expect(c).toMatchObject({
      enabled: true,
      subagents: "off",
      maxUsdPerMTokIn: 1,
      timeoutMs: 10_000,
      minChars: 10,
    })
  })

  test("valid block", () => {
    const c = parseTitleConfig(
      wrap({
        enabled: false,
        model: " cheap-1 ",
        modes: ["repl", "one-shot", "repl"],
        subagents: "derived",
        effort: "medium",
        maxUsdPerMTokIn: 0,
        timeoutMs: 5000,
        minChars: 4,
      }),
    )
    expect(c).toEqual({
      enabled: false,
      model: "cheap-1",
      modes: ["repl", "one-shot"],
      subagents: "derived",
      effort: "medium",
      maxUsdPerMTokIn: 0,
      timeoutMs: 5000,
      minChars: 4,
    })
  })

  test("unknown key and wrong types: default + debug log", () => {
    const logs: string[] = []
    const c = parseTitleConfig(
      wrap({
        foo: 1,
        enabled: "yes",
        model: "",
        modes: "repl",
        subagents: "all",
        effort: "max",
        maxUsdPerMTokIn: -1,
        timeoutMs: "x",
        minChars: 0,
      }),
      (m) => logs.push(m),
    )
    expect(c).toEqual(defaultTitleConfig())
    expect(logs.some((l) => l.includes("foo: unknown key"))).toBe(true)
    for (const key of [
      "enabled",
      "model",
      "modes",
      "subagents",
      "effort",
      "maxUsdPerMTokIn",
      "timeoutMs",
      "minChars",
    ]) {
      expect(logs.some((l) => l.includes(`.${key}: wrong value`))).toBe(true)
    }
  })

  test("unknown modes are ignored with a log", () => {
    const logs: string[] = []
    const c = parseTitleConfig(wrap({ modes: ["repl", "tui", 3] }), (m) => logs.push(m))
    expect(c.modes).toEqual(["repl"])
    expect(logs.length).toBe(2)
  })

  test("timeoutMs is clamped to 1000-30000", () => {
    expect(parseTitleConfig(wrap({ timeoutMs: 10 })).timeoutMs).toBe(1000)
    expect(parseTitleConfig(wrap({ timeoutMs: 99_999 })).timeoutMs).toBe(30_000)
  })

  test("a block that is not an object gives defaults", () => {
    expect(parseTitleConfig(wrap("on"))).toEqual(defaultTitleConfig())
    expect(parseTitleConfig({ plugins: [] })).toEqual(defaultTitleConfig())
    expect(parseTitleConfig(null)).toEqual(defaultTitleConfig())
  })
})

describe("env and args precedence", () => {
  test("readTitleEnv", () => {
    expect(readTitleEnv({})).toEqual({})
    expect(readTitleEnv({ MINIMAL_AGENT_TITLE: "0" })).toEqual({ title: false })
    expect(readTitleEnv({ MINIMAL_AGENT_TITLE: " 1 " })).toEqual({ title: true })
    expect(readTitleEnv({ MINIMAL_AGENT_TITLE: "true" })).toEqual({})
    expect(readTitleEnv({ MINIMAL_AGENT_TITLE_MODEL: " m-1 " })).toEqual({ model: "m-1" })
    expect(readTitleEnv({ MINIMAL_AGENT_TITLE_MODEL: "  " })).toEqual({})
  })

  test("switch: args > env > unset", () => {
    expect(resolveTitleSwitch({ title: false }, { title: true })).toBe(false)
    expect(resolveTitleSwitch({ title: true }, { title: false })).toBe(true)
    expect(resolveTitleSwitch({}, { title: false })).toBe(false)
    expect(resolveTitleSwitch(undefined, { title: true })).toBe(true)
    expect(resolveTitleSwitch(undefined, {})).toBeUndefined()
  })

  test("model: env > config > unset", () => {
    const config = { ...defaultTitleConfig(), model: "cfg-model" }
    expect(resolveModelOverride(config, { model: "env-model" })).toBe("env-model")
    expect(resolveModelOverride(config, {})).toBe("cfg-model")
    expect(resolveModelOverride(defaultTitleConfig(), {})).toBeUndefined()
  })
})

describe("loadTitleConfig (temp dir only)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-title-config-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("MINIMAL_AGENT_HOME: reads config.jsonc with comments", () => {
    const home = join(dir, ".minimal-agent")
    mkdirSync(home)
    writeFileSync(
      join(home, "config.jsonc"),
      '{ // c\n "plugins": { "title": { "modes": ["repl"], "minChars": 5, } } }',
    )
    const env = { MINIMAL_AGENT_HOME: home }
    expect(titleConfigPath(env)).toBe(join(home, "config.jsonc"))
    const c = loadTitleConfig(env)
    expect(c.modes).toEqual(["repl"])
    expect(c.minChars).toBe(5)
  })

  test("MINIMAL_AGENT_HOME: falls back to config.json", () => {
    const home = join(dir, ".minimal-agent")
    mkdirSync(home)
    writeFileSync(join(home, "config.json"), JSON.stringify(wrap({ timeoutMs: 2000 })))
    expect(loadTitleConfig({ MINIMAL_AGENT_HOME: home }).timeoutMs).toBe(2000)
  })

  test("MINIMAL_AGENT_CONFIG wins over MINIMAL_AGENT_HOME", () => {
    const file = join(dir, "custom.jsonc")
    writeFileSync(file, JSON.stringify(wrap({ subagents: "model" })))
    const env = { MINIMAL_AGENT_CONFIG: file, MINIMAL_AGENT_HOME: join(dir, "none") }
    expect(titleConfigPath(env)).toBe(file)
    expect(loadTitleConfig(env).subagents).toBe("model")
  })

  test("missing file → defaults", () => {
    expect(loadTitleConfig({ MINIMAL_AGENT_HOME: join(dir, "nope") })).toEqual(defaultTitleConfig())
  })

  test("bad JSONC → defaults + debug log, no throw", () => {
    const file = join(dir, "bad.jsonc")
    writeFileSync(file, "{ plugins: ")
    const logs: string[] = []
    expect(loadTitleConfig({ MINIMAL_AGENT_CONFIG: file }, (m) => logs.push(m))).toEqual(
      defaultTitleConfig(),
    )
    expect(logs[0]).toContain("parse error")
  })

  test("cache: no new read while mtime and size do not change; a new mtime reads again", () => {
    clearTitleConfigCache()
    const file = join(dir, "cached.jsonc")
    writeFileSync(file, JSON.stringify(wrap({ minChars: 5 })))
    const t0 = new Date("2026-01-01T00:00:00Z")
    utimesSync(file, t0, t0)
    const env = { MINIMAL_AGENT_CONFIG: file }
    const first = loadTitleConfig(env)
    expect(first.minChars).toBe(5)

    // Same size, same mtime: the cached value comes back (the file is not read).
    writeFileSync(file, JSON.stringify(wrap({ minChars: 7 })))
    utimesSync(file, t0, t0)
    expect(loadTitleConfig(env).minChars).toBe(5)

    // A caller change does not change the cache.
    first.minChars = 99
    expect(loadTitleConfig(env).minChars).toBe(5)

    // A new mtime: the loader reads the file again.
    const t1 = new Date("2026-01-02T00:00:00Z")
    utimesSync(file, t1, t1)
    expect(loadTitleConfig(env).minChars).toBe(7)
  })
})
