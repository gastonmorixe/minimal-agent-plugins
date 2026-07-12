/**
 * Tests for agents-md config loading.
 *
 * @module lib/config.test
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { DEFAULT_AGENTS_MD_CONFIG, DEFAULT_MAX_BYTES, loadAgentsMdConfig } from "./config.ts"

const ROOT = join(import.meta.dir, "../../tmp-agents-md-config-tests")
let n = 0

function tmp(): string {
  const dir = join(ROOT, `case-${++n}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe("loadAgentsMdConfig", () => {
  test("defaults when no config file", () => {
    const home = tmp()
    const cfg = loadAgentsMdConfig({ MINIMAL_AGENT_HOME: home })
    expect(cfg).toEqual(DEFAULT_AGENTS_MD_CONFIG)
    expect(cfg.maxBytes).toBe(DEFAULT_MAX_BYTES)
  })

  test('reads plugins["agents-md"] from config.jsonc under agent home', () => {
    const home = tmp()
    writeFileSync(
      join(home, "config.jsonc"),
      `{
        // comment ok
        "plugins": {
          "agents-md": {
            "global": false,
            "project": true,
            "maxBytes": 1234,
          },
        },
      }`,
    )
    const cfg = loadAgentsMdConfig({ MINIMAL_AGENT_HOME: home })
    expect(cfg.global).toBe(false)
    expect(cfg.project).toBe(true)
    expect(cfg.maxBytes).toBe(1234)
  })

  test("MINIMAL_AGENT_CONFIG path wins", () => {
    const home = tmp()
    const other = join(tmp(), "custom.jsonc")
    writeFileSync(
      other,
      JSON.stringify({ plugins: { "agents-md": { global: false, project: false } } }),
    )
    // decoy at agent home must be ignored
    writeFileSync(
      join(home, "config.jsonc"),
      JSON.stringify({ plugins: { "agents-md": { global: true, project: true } } }),
    )
    const cfg = loadAgentsMdConfig({
      MINIMAL_AGENT_HOME: home,
      MINIMAL_AGENT_CONFIG: other,
    })
    expect(cfg.global).toBe(false)
    expect(cfg.project).toBe(false)
  })

  test("accepts agentsMd and ma-agents-md aliases", () => {
    const home = tmp()
    writeFileSync(
      join(home, "config.jsonc"),
      JSON.stringify({ plugins: { agentsMd: { maxBytes: 42 } } }),
    )
    expect(loadAgentsMdConfig({ MINIMAL_AGENT_HOME: home }).maxBytes).toBe(42)

    const home2 = tmp()
    writeFileSync(
      join(home2, "config.jsonc"),
      JSON.stringify({ plugins: { "ma-agents-md": { global: false } } }),
    )
    expect(loadAgentsMdConfig({ MINIMAL_AGENT_HOME: home2 }).global).toBe(false)
  })

  test("ignores invalid types (lenient)", () => {
    const home = tmp()
    writeFileSync(
      join(home, "config.jsonc"),
      JSON.stringify({
        plugins: {
          "agents-md": {
            global: "nope",
            project: 1,
            maxBytes: -5,
          },
        },
      }),
    )
    const cfg = loadAgentsMdConfig({ MINIMAL_AGENT_HOME: home })
    expect(cfg).toEqual(DEFAULT_AGENTS_MD_CONFIG)
  })

  test("malformed JSON → defaults, never throws", () => {
    const home = tmp()
    writeFileSync(join(home, "config.jsonc"), "{ not json")
    expect(loadAgentsMdConfig({ MINIMAL_AGENT_HOME: home })).toEqual(DEFAULT_AGENTS_MD_CONFIG)
  })
})
