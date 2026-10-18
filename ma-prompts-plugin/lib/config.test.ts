/**
 * Config tests: defaults and tolerant parsing.
 */

import { describe, expect, it } from "bun:test"

import { defaultConfig, parsePromptsConfig } from "../lib/config.ts"
import { parseJsonc } from "../lib/jsonc.ts"

describe("parsePromptsConfig", () => {
  it("returns defaults for junk", () => {
    expect(parsePromptsConfig(null)).toEqual(defaultConfig())
    expect(parsePromptsConfig({})).toEqual(defaultConfig())
    expect(parsePromptsConfig({ plugins: {} })).toEqual(defaultConfig())
  })

  it("reads the enabled flag", () => {
    const c = parsePromptsConfig({ plugins: { "ma-prompts": { enabled: false } } })
    expect(c.enabled).toBe(false)
  })

  it("reads projectScope and caps", () => {
    const c = parsePromptsConfig({
      plugins: { "ma-prompts": { projectScope: true, maxPrompts: 10, maxBodyBytes: 100 } },
    })
    expect(c.projectScope).toBe(true)
    expect(c.maxPrompts).toBe(10)
    expect(c.maxBodyBytes).toBe(100)
  })

  it("drops wrong types", () => {
    const c = parsePromptsConfig({
      plugins: { "ma-prompts": { enabled: "yes", maxPrompts: -1 } },
    })
    expect(c.enabled).toBe(true)
    expect(c.maxPrompts).toBe(defaultConfig().maxPrompts)
  })

  it("accepts a one-char sigil only", () => {
    const ok = parsePromptsConfig({ plugins: { "ma-prompts": { sigil: "%" } } })
    expect(ok.sigil).toBe("%")
    const bad = parsePromptsConfig({ plugins: { "ma-prompts": { sigil: "ab" } } })
    expect(bad.sigil).toBe("&")
  })
})

describe("parseJsonc", () => {
  it("strips line and block comments", () => {
    const v = parseJsonc('{\n // hi\n "a": 1, /* x */ "b": 2\n}') as Record<string, number>
    expect(v).toEqual({ a: 1, b: 2 })
  })

  it("keeps a comment-like string", () => {
    const v = parseJsonc('{"url": "http://x"}') as Record<string, string>
    expect(v.url).toBe("http://x")
  })

  it("drops trailing commas", () => {
    const v = parseJsonc('{"a": [1,2,],}') as Record<string, number[]>
    expect(v.a).toEqual([1, 2])
  })
})
