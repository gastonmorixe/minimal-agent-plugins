/**
 * Integration: load this plugin through the real host PluginLoader and
 * assert the fragment lands in getPromptBlockAsync().
 *
 * That method is the shared seam for both the legacy `Agent` loop
 * (`sessionContext`) and the modern `AgentCore` SDK
 * (`PromptContributorAdapter.systemPromptBlocks()`), so one integration
 * covers both runtimes without spinning up a full agent.
 *
 * Skipped when the sibling minimal-agent checkout is not present (the
 * plugins repo is independently clonable).
 *
 * @module integration.test
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

const CORE_LOADER = resolve(import.meta.dir, "../../minimal-agent/src/plugins/loader.ts")
const CORE_PRESENT = existsSync(CORE_LOADER)
const THIS_PLUGIN = import.meta.dir

const ROOT = join(import.meta.dir, "../tmp-agents-md-integration")
let n = 0

function tmp(): string {
  const dir = join(ROOT, `case-${++n}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Build a sibling-style root that contains ONLY this plugin package, so
 * PluginLoader discovery does not pull the whole plugins fleet.
 */
function isolatedSiblingRoot(): string {
  const root = tmp()
  // Copy the package (manifest + handlers + lib + PROMPT.md). Tests write
  // AGENTS.md into agent-home/cwd separately; we don't need node_modules.
  const dest = join(root, "ma-agents-md-plugin")
  cpSync(THIS_PLUGIN, dest, {
    recursive: true,
    filter: (src) => {
      // Skip test tmpdirs and test files; keep production sources.
      const base = src.slice(THIS_PLUGIN.length)
      if (base.includes("tmp-agents-md")) return false
      if (base.endsWith(".test.ts")) return false
      if (base.endsWith("integration.test.ts")) return false
      return true
    },
  })
  return root
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe.skipIf(!CORE_PRESENT)("agents-md via PluginLoader (legacy + AgentCore seam)", () => {
  test("getPromptBlockAsync includes global then project AGENTS.md", async () => {
    const { PluginLoader } = await import(CORE_LOADER)

    const siblingRoot = isolatedSiblingRoot()
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "INT-GLOBAL")
    writeFileSync(join(cwd, "AGENTS.md"), "INT-PROJECT")

    const prevCwd = process.cwd()
    const prevHome = process.env.MINIMAL_AGENT_HOME
    try {
      process.chdir(cwd)
      process.env.MINIMAL_AGENT_HOME = agentHome

      const loader = await PluginLoader.load({
        siblingDirs: [siblingRoot],
        embeddedDir: join(tmp(), "no-embedded"),
        userDir: join(tmp(), "no-user"),
        homeDir: join(tmp(), "no-home"),
        projectDir: join(tmp(), "no-project"),
        coreToolNames: new Set<string>(),
      })

      const block = await loader.getPromptBlockAsync()
      expect(typeof block).toBe("string")
      expect(block).not.toBeNull()
      // classifyPluginPrompt → context role, name slug of PROMPT.md H1 "AGENTS.md"
      expect(block!).toContain('<ma::sys::context name="agents-md">')
      expect(block!).toContain("INT-GLOBAL")
      expect(block!).toContain("INT-PROJECT")
      expect(block!.indexOf("INT-GLOBAL")).toBeLessThan(block!.indexOf("INT-PROJECT"))
      // Framing from PROMPT.md (H1 stripped) + fragment body.
      expect(block!).toContain("Agent instructions (AGENTS.md)")
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })

  test("disabledPluginIds skips the fragment entirely", async () => {
    const { PluginLoader } = await import(CORE_LOADER)
    const siblingRoot = isolatedSiblingRoot()
    const agentHome = tmp()
    const cwd = tmp()
    writeFileSync(join(agentHome, "AGENTS.md"), "SHOULD-NOT-APPEAR")
    writeFileSync(join(cwd, "AGENTS.md"), "SHOULD-NOT-APPEAR-EITHER")

    const prevCwd = process.cwd()
    const prevHome = process.env.MINIMAL_AGENT_HOME
    try {
      process.chdir(cwd)
      process.env.MINIMAL_AGENT_HOME = agentHome

      const loader = await PluginLoader.load({
        siblingDirs: [siblingRoot],
        embeddedDir: join(tmp(), "no-embedded"),
        userDir: join(tmp(), "no-user"),
        homeDir: join(tmp(), "no-home"),
        projectDir: join(tmp(), "no-project"),
        coreToolNames: new Set<string>(),
        disabledPluginIds: new Set(["agents-md"]),
      })

      const block = (await loader.getPromptBlockAsync()) ?? ""
      expect(block).not.toContain("SHOULD-NOT-APPEAR")
      expect(block).not.toContain("agents-md")
      expect(block).not.toContain("Agent instructions (AGENTS.md)")
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })

  test("empty when neither AGENTS.md exists (plugin silent)", async () => {
    const { PluginLoader } = await import(CORE_LOADER)
    const siblingRoot = isolatedSiblingRoot()
    const agentHome = tmp()
    const cwd = tmp()

    const prevCwd = process.cwd()
    const prevHome = process.env.MINIMAL_AGENT_HOME
    try {
      process.chdir(cwd)
      process.env.MINIMAL_AGENT_HOME = agentHome

      const loader = await PluginLoader.load({
        siblingDirs: [siblingRoot],
        embeddedDir: join(tmp(), "no-embedded"),
        userDir: join(tmp(), "no-user"),
        homeDir: join(tmp(), "no-home"),
        projectDir: join(tmp(), "no-project"),
        coreToolNames: new Set<string>(),
      })

      const block = await loader.getPromptBlockAsync()
      // PROMPT.md still contributes a context section even with empty fragment.
      // That is intentional: the framing teaches the model about AGENTS.md.
      // But the dynamic bodies must be absent.
      if (block) {
        expect(block).not.toContain("### Global")
        expect(block).not.toContain("### Project")
      }
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })
})
