/**
 * Integration (SPEC.md "Testing Decisions" step 2, B3 MINOR 5): boot the
 * REAL core plugin loader with only this plugin, then emit
 * `tool.willInvoke` through the loader's HookBus facade. A real shell
 * script from `~/.claude/settings.json` denies `rm -rf`.
 *
 * The loader runs in this process, so the hook handler reads
 * `process.env` and `process.cwd()` (core `event-subs.ts` sets
 * `ctx.cwd = process.cwd()`). The test points both at the sandbox and
 * restores them after.
 */

import { mkdirSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

import { resetEngine } from "../handlers/dispatch.ts"

import { makeSandbox, type Sandbox } from "./test-support.ts"

const PLUGIN_DIR = resolve(import.meta.dir, "..")
const ENV_KEYS = ["HOME", "MINIMAL_AGENT_HOME", "MINIMAL_AGENT_CONFIG", "MA_TRUST_HOOKS"] as const

let sb: Sandbox
let loader: PluginLoader
const logs: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const savedCwd = process.cwd()

beforeAll(async () => {
  sb = makeSandbox()
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.HOME = sb.home
  delete process.env.MINIMAL_AGENT_HOME
  delete process.env.MINIMAL_AGENT_CONFIG
  delete process.env.MA_TRUST_HOOKS
  const deny = sb.script(
    "deny-rm.sh",
    `input=$(cat)\ncase "$input" in\n  *"rm -rf"*) echo "rm -rf is blocked by policy" >&2; exit 2 ;;\nesac\nexit 0`,
  )
  sb.write(
    join(sb.home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: deny }] }] },
    }),
  )
  // A plugin root that holds only this plugin (a symlink to the checkout).
  const root = join(sb.root, "plugins")
  mkdirSync(root, { recursive: true })
  symlinkSync(PLUGIN_DIR, join(root, "ma-hooks-plugin"))
  resetEngine()
  loader = await PluginLoader.load({ roots: { user: [root] }, logger: (m) => logs.push(m) })
  process.chdir(sb.project)
})

afterAll(() => {
  process.chdir(savedCwd)
  resetEngine()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  sb.cleanup()
})

const bash = (command: string) => ({
  tool: "Bash",
  toolUseId: "tu-1",
  input: { command },
  cwd: process.cwd(),
})

describe("real PluginLoader + HookBus with the hooks plugin", () => {
  test("the loader loads only the hooks plugin and subscribes tool.willInvoke", () => {
    expect(loader.loadedPluginIds()).toEqual(["hooks"])
    const channels = loader.getHookSubs().map((s) => s.sub.definition.channel)
    expect(channels).toContain("tool.willInvoke")
  })

  test("a PreToolUse script that exits 2 halts tool.willInvoke with its reason", async () => {
    const r = await loader.hooks().emitChain("tool.willInvoke", bash("rm -rf /"))
    expect(r.halted).toBe(true)
    expect(r.reason).toContain("rm -rf is blocked by policy")
  })

  test("a safe command passes", async () => {
    const r = await loader.hooks().emitChain("tool.willInvoke", bash("ls"))
    expect(r.halted).toBe(false)
    expect(r.payload).toMatchObject({ tool: "Bash", input: { command: "ls" } })
  })
})
