/**
 * Tests for the prompt-fragment producer (handler entry).
 *
 * @module handlers/load.test
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import agentsMdFragment from "./load.ts"

const ROOT = join(import.meta.dir, "../../tmp-agents-md-handler-tests")
let n = 0

function tmp(): string {
  const dir = join(ROOT, `case-${++n}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe("agentsMdFragment handler", () => {
  test("returns empty when no files", () => {
    const text = agentsMdFragment({
      cwd: tmp(),
      env: { MINIMAL_AGENT_HOME: tmp() },
    })
    expect(text).toBe("")
  })

  test("injects global then project", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "GLOBAL-RULE")
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-RULE")
    const notices: string[] = []
    const text = agentsMdFragment({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
      log: { notice: (m) => notices.push(m) },
    })
    expect(text).toContain("GLOBAL-RULE")
    expect(text).toContain("PROJECT-RULE")
    expect(text.indexOf("GLOBAL-RULE")).toBeLessThan(text.indexOf("PROJECT-RULE"))
    expect(notices).toEqual([])
  })

  test('honors plugins["agents-md"].project = false from agent-home config', () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "GLOBAL-RULE")
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-RULE")
    writeFileSync(
      join(agentHome, "config.jsonc"),
      JSON.stringify({ plugins: { "agents-md": { project: false } } }),
    )
    const text = agentsMdFragment({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
    })
    expect(text).toContain("GLOBAL-RULE")
    expect(text).not.toContain("PROJECT-RULE")
  })

  test("logs skip when file exceeds maxBytes", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(cwd, "AGENTS.md"), "x".repeat(200))
    writeFileSync(
      join(agentHome, "config.jsonc"),
      JSON.stringify({ plugins: { "agents-md": { maxBytes: 10 } } }),
    )
    const notices: string[] = []
    const text = agentsMdFragment({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
      log: { notice: (m) => notices.push(m) },
    })
    expect(text).toBe("")
    expect(notices.some((n) => n.includes("maxBytes=10"))).toBe(true)
  })
})
