/**
 * Tests for AGENTS.md discovery + rendering.
 *
 * Drive pure helpers with tmpdirs. No host / loader involved.
 *
 * @module lib/load.test
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  collectAgentsMdSources,
  globalAgentsMdPath,
  loadAgentsMdFragment,
  projectAgentsMdPath,
  readAgentsMdFile,
  renderAgentsMdFragment,
} from "./load.ts"

const ROOT = join(import.meta.dir, "../../tmp-agents-md-load-tests")
let n = 0

function tmp(): string {
  const dir = join(ROOT, `case-${++n}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

describe("globalAgentsMdPath", () => {
  test("honors MINIMAL_AGENT_HOME (never hardcodes ~/.minimal-agent)", () => {
    const home = "/custom/agent-home"
    expect(globalAgentsMdPath({ MINIMAL_AGENT_HOME: home })).toBe(join(home, "AGENTS.md"))
  })

  test("falls back to HOME/.minimal-agent when MINIMAL_AGENT_HOME unset", () => {
    const home = "/Users/tester"
    expect(globalAgentsMdPath({ HOME: home })).toBe(join(home, ".minimal-agent", "AGENTS.md"))
  })
})

describe("projectAgentsMdPath", () => {
  test("joins cwd/AGENTS.md", () => {
    expect(projectAgentsMdPath("/work/proj")).toBe("/work/proj/AGENTS.md")
  })
})

// ---------------------------------------------------------------------------
// readAgentsMdFile
// ---------------------------------------------------------------------------

describe("readAgentsMdFile", () => {
  test("returns null when missing", () => {
    expect(readAgentsMdFile(join(tmp(), "nope.md"), 1000)).toBeNull()
  })

  test("returns trimmed body", () => {
    const dir = tmp()
    const path = join(dir, "AGENTS.md")
    writeFileSync(path, "\n  hello world  \n")
    expect(readAgentsMdFile(path, 1000)).toBe("hello world")
  })

  test("strips UTF-8 BOM", () => {
    const dir = tmp()
    const path = join(dir, "AGENTS.md")
    writeFileSync(path, "\uFEFF# Title\nbody")
    expect(readAgentsMdFile(path, 1000)).toBe("# Title\nbody")
  })

  test("returns null for empty / whitespace-only", () => {
    const dir = tmp()
    const path = join(dir, "AGENTS.md")
    writeFileSync(path, "  \n\t  \n")
    const skips: string[] = []
    expect(readAgentsMdFile(path, 1000, (r) => skips.push(r))).toBeNull()
    expect(skips.some((s) => s.includes("empty"))).toBe(true)
  })

  test("returns null when over maxBytes and reports skip", () => {
    const dir = tmp()
    const path = join(dir, "AGENTS.md")
    writeFileSync(path, "x".repeat(50))
    const skips: string[] = []
    expect(readAgentsMdFile(path, 10, (r) => skips.push(r))).toBeNull()
    expect(skips[0]).toContain("maxBytes=10")
  })
})

// ---------------------------------------------------------------------------
// collect + render order
// ---------------------------------------------------------------------------

describe("collectAgentsMdSources", () => {
  test("global first, project second", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "GLOBAL BODY")
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT BODY")

    const sources = collectAgentsMdSources({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
    })
    expect(sources.map((s) => s.scope)).toEqual(["global", "project"])
    expect(sources[0].body).toBe("GLOBAL BODY")
    expect(sources[1].body).toBe("PROJECT BODY")
  })

  test("global only when project missing", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "GLOBAL ONLY")
    const sources = collectAgentsMdSources({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
    })
    expect(sources).toHaveLength(1)
    expect(sources[0].scope).toBe("global")
  })

  test("project only when global missing", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT ONLY")
    const sources = collectAgentsMdSources({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
    })
    expect(sources).toHaveLength(1)
    expect(sources[0].scope).toBe("project")
  })

  test("empty when both missing", () => {
    const sources = collectAgentsMdSources({
      cwd: tmp(),
      env: { MINIMAL_AGENT_HOME: tmp() },
    })
    expect(sources).toEqual([])
  })

  test("respects config.global = false", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "GLOBAL")
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT")
    const sources = collectAgentsMdSources({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
      config: { global: false, project: true, maxBytes: 100_000 },
    })
    expect(sources.map((s) => s.scope)).toEqual(["project"])
  })

  test("respects config.project = false", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "GLOBAL")
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT")
    const sources = collectAgentsMdSources({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
      config: { global: true, project: false, maxBytes: 100_000 },
    })
    expect(sources.map((s) => s.scope)).toEqual(["global"])
  })
})

describe("renderAgentsMdFragment", () => {
  test("empty sources → empty string", () => {
    expect(renderAgentsMdFragment([])).toBe("")
  })

  test("joins raw bodies with blank line; no framing", () => {
    const text = renderAgentsMdFragment([
      { scope: "global", path: "/home/me/.minimal-agent/AGENTS.md", body: "G" },
      { scope: "project", path: "/work/proj/AGENTS.md", body: "P" },
    ])
    expect(text).toBe("G\n\nP")
    expect(text).not.toContain("## Agent instructions")
    expect(text).not.toContain("### Global")
    expect(text).not.toContain("### Project")
    expect(text).not.toContain("prefer the project file")
  })
})

describe("loadAgentsMdFragment", () => {
  test("end-to-end both files", () => {
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "# Global\nuse bun")
    writeFileSync(join(cwd, "AGENTS.md"), "# Project\nuse oxlint")
    const text = loadAgentsMdFragment({
      cwd,
      env: { MINIMAL_AGENT_HOME: agentHome },
    })
    expect(text).toContain("use bun")
    expect(text).toContain("use oxlint")
    expect(text.indexOf("use bun")).toBeLessThan(text.indexOf("use oxlint"))
  })
})
