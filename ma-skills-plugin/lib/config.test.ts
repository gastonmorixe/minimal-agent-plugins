/**
 * Tests for the plugin config loader.
 *
 * @module lib/config.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { defaultConfig, loadSkillsConfig, parseSkillsConfig } from "./config.ts"

describe("defaultConfig", () => {
  test("returns sensible defaults", () => {
    const c = defaultConfig()
    expect(c.enabled).toBe(true)
    expect(c.roots.project).toBe(true)
    expect(c.roots.projectClaudeCode).toBe(false)
    expect(c.roots.homeShared).toBe(true)
    expect(c.roots.userAgent).toBe(true)
    expect(c.extraRoots).toEqual([])
    expect(c.maxSkills).toBe(64)
    expect(c.allowReservedNames).toBe(false)
  })

  test("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultConfig()
    const b = defaultConfig()
    a.roots.project = false
    expect(b.roots.project).toBe(true)
  })
})

describe("parseSkillsConfig — degenerate inputs", () => {
  test("null → defaults", () => {
    expect(parseSkillsConfig(null)).toEqual(defaultConfig())
  })
  test("undefined → defaults", () => {
    expect(parseSkillsConfig(undefined)).toEqual(defaultConfig())
  })
  test("non-object → defaults", () => {
    expect(parseSkillsConfig(42)).toEqual(defaultConfig())
    expect(parseSkillsConfig("hi")).toEqual(defaultConfig())
    expect(parseSkillsConfig([1, 2])).toEqual(defaultConfig())
  })
  test("missing plugins key → defaults", () => {
    expect(parseSkillsConfig({})).toEqual(defaultConfig())
  })
  test("missing ma-skills section → defaults", () => {
    expect(parseSkillsConfig({ plugins: { other: {} } })).toEqual(defaultConfig())
  })
  test("plugins not an object → defaults", () => {
    expect(parseSkillsConfig({ plugins: "string" })).toEqual(defaultConfig())
  })
})

describe("parseSkillsConfig — enabled flag", () => {
  test("explicit false disables", () => {
    const c = parseSkillsConfig({ plugins: { "ma-skills": { enabled: false } } })
    expect(c.enabled).toBe(false)
  })
  test("explicit true (redundant) preserved", () => {
    const c = parseSkillsConfig({ plugins: { "ma-skills": { enabled: true } } })
    expect(c.enabled).toBe(true)
  })
  test("non-boolean enabled ignored", () => {
    const c = parseSkillsConfig({ plugins: { "ma-skills": { enabled: "yes" } } })
    expect(c.enabled).toBe(true) // stays default
  })
})

describe("parseSkillsConfig — roots", () => {
  test("flipping individual roots", () => {
    const c = parseSkillsConfig({
      plugins: {
        "ma-skills": {
          roots: { project: false, projectClaudeCode: true },
        },
      },
    })
    expect(c.roots.project).toBe(false)
    expect(c.roots.projectClaudeCode).toBe(true)
    expect(c.roots.homeShared).toBe(true) // default
    expect(c.roots.userAgent).toBe(true) // default
  })
  test("non-object roots ignored", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { roots: "all" } },
    })
    expect(c.roots).toEqual(defaultConfig().roots)
  })
  test("non-boolean root values ignored", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { roots: { project: "off", homeShared: 0 } } },
    })
    expect(c.roots.project).toBe(true)
    expect(c.roots.homeShared).toBe(true)
  })
})

describe("parseSkillsConfig — extraRoots", () => {
  test("absolute paths accepted", () => {
    const c = parseSkillsConfig({
      plugins: {
        "ma-skills": { extraRoots: ["/abs/one", "/abs/two"] },
      },
    })
    expect(c.extraRoots).toEqual(["/abs/one", "/abs/two"])
  })
  test("relative paths rejected", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { extraRoots: ["./rel", "../up", "skills"] } },
    })
    expect(c.extraRoots).toEqual([])
  })
  test("empty strings + non-strings dropped", () => {
    const c = parseSkillsConfig({
      plugins: {
        "ma-skills": { extraRoots: ["", "   ", 5, null, "/ok"] },
      },
    })
    expect(c.extraRoots).toEqual(["/ok"])
  })
  test("non-array extraRoots ignored", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { extraRoots: "/single" } },
    })
    expect(c.extraRoots).toEqual([])
  })
  test("whitespace trimmed", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { extraRoots: ["  /abs/one  "] } },
    })
    expect(c.extraRoots).toEqual(["/abs/one"])
  })
})

describe("parseSkillsConfig — maxSkills", () => {
  test("valid integer applied", () => {
    const c = parseSkillsConfig({ plugins: { "ma-skills": { maxSkills: 200 } } })
    expect(c.maxSkills).toBe(200)
  })
  test("floors non-integer", () => {
    const c = parseSkillsConfig({ plugins: { "ma-skills": { maxSkills: 7.9 } } })
    expect(c.maxSkills).toBe(7)
  })
  test("out-of-range ignored", () => {
    expect(parseSkillsConfig({ plugins: { "ma-skills": { maxSkills: 0 } } }).maxSkills).toBe(64)
    expect(parseSkillsConfig({ plugins: { "ma-skills": { maxSkills: -1 } } }).maxSkills).toBe(64)
    expect(parseSkillsConfig({ plugins: { "ma-skills": { maxSkills: 1e6 } } }).maxSkills).toBe(64)
  })
  test("non-finite ignored", () => {
    expect(
      parseSkillsConfig({
        plugins: { "ma-skills": { maxSkills: Number.NaN } },
      }).maxSkills,
    ).toBe(64)
    expect(
      parseSkillsConfig({
        plugins: { "ma-skills": { maxSkills: Number.POSITIVE_INFINITY } },
      }).maxSkills,
    ).toBe(64)
  })
})

describe("parseSkillsConfig — allowReservedNames", () => {
  test("explicit true accepted", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { allowReservedNames: true } },
    })
    expect(c.allowReservedNames).toBe(true)
  })
  test("non-boolean ignored", () => {
    const c = parseSkillsConfig({
      plugins: { "ma-skills": { allowReservedNames: "yes" } },
    })
    expect(c.allowReservedNames).toBe(false)
  })
})

describe("loadSkillsConfig - malformed config file", () => {
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
        const cfg = loadSkillsConfig((message, data) => calls.push({ message, data }))
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
      expect(loadSkillsConfig()).toEqual(defaultConfig())
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  test("a load without a callback does not use up the report for a later one", () => {
    const path = badFile()
    loadSkillsConfig()
    const calls: unknown[] = []
    loadSkillsConfig((_message, data) => calls.push(data))
    expect(calls).toEqual([{ path }])
  })

  test("a callback that throws does not break the load", () => {
    badFile()
    expect(
      loadSkillsConfig(() => {
        throw new Error("sink down")
      }),
    ).toEqual(defaultConfig())
  })
})
