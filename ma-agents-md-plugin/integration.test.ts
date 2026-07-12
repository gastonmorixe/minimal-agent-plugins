/**
 * Integration: load this plugin through the real host PluginLoader and
 * assert the fragment lands in `getPromptBlocksAsync().afterInstructions`
 * as plain markdown (no `<ma::sys` wrap).
 *
 * That dual-block API is the shared seam for both the legacy `Agent`
 * loop and the modern `AgentCore` SDK once Phase 4 wires consumers.
 * `getPromptBlockAsync()` stays the sessionContext-only back-compat path
 * and must NOT contain the AGENTS body after placement.
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
  // Copy the package (manifest + handlers + lib). Tests write AGENTS.md into
  // agent-home/cwd separately; we don't need node_modules.
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

describe.skipIf(!CORE_PRESENT)("agents-md via PluginLoader (afterInstructions placement)", () => {
  test("getPromptBlocksAsync puts AGENTS body in afterInstructions as plain markdown", async () => {
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

      // Prefer dual API when present (Phase 3+). Fall back fails the suite
      // intentionally if core is too old for afterInstructions placement.
      expect(typeof loader.getPromptBlocksAsync).toBe("function")
      const blocks = await loader.getPromptBlocksAsync()
      const after = blocks.afterInstructions
      expect(typeof after).toBe("string")
      expect(after).not.toBeNull()
      expect(after!).toContain("INT-GLOBAL")
      expect(after!).toContain("INT-PROJECT")
      expect(after!.indexOf("INT-GLOBAL")).toBeLessThan(after!.indexOf("INT-PROJECT"))
      // Fragment render framing (from lib/load), not PROMPT.md / XML.
      expect(after!).toContain("Agent instructions (AGENTS.md)")
      // Plain placement: no ma::sys wrapper around the AGENTS content.
      expect(after!).not.toContain("<ma::sys")
      expect(after!).not.toContain('name="agents-md"')

      // sessionContext path must not double-emit the AGENTS body.
      const session = blocks.sessionContext
      if (session) {
        expect(session).not.toContain("INT-GLOBAL")
        expect(session).not.toContain("INT-PROJECT")
        expect(session).not.toContain("Agent instructions (AGENTS.md)")
        expect(session).not.toContain('<ma::sys::context name="agents-md">')
      }

      // Back-compat getter is sessionContext only.
      const legacy = await loader.getPromptBlockAsync()
      if (legacy) {
        expect(legacy).not.toContain("INT-GLOBAL")
        expect(legacy).not.toContain("INT-PROJECT")
      }
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

      const blocks = await loader.getPromptBlocksAsync()
      expect(blocks.afterInstructions ?? "").not.toContain("SHOULD-NOT-APPEAR")
      expect(blocks.sessionContext ?? "").not.toContain("SHOULD-NOT-APPEAR")
      expect(blocks.afterInstructions ?? "").not.toContain("agents-md")
      expect(blocks.afterInstructions ?? "").not.toContain("Agent instructions (AGENTS.md)")
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

      const blocks = await loader.getPromptBlocksAsync()
      // No AGENTS files + no PROMPT.md → nothing in either slot from this plugin.
      expect(blocks.afterInstructions).toBeNull()
      if (blocks.sessionContext) {
        expect(blocks.sessionContext).not.toContain("### Global")
        expect(blocks.sessionContext).not.toContain("### Project")
        expect(blocks.sessionContext).not.toContain('<ma::sys::context name="agents-md">')
        expect(blocks.sessionContext).not.toContain("Agent instructions (AGENTS.md)")
      }
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })
})
