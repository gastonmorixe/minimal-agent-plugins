/**
 * Integration: boot the REAL core plugin loader with only this plugin, then
 * emit the core chain channel `startup.rows` through the loader's HookBus
 * facade. A temp HOME with one native hook yields one `hooks` row. A temp
 * HOME with no hooks leaves `rows` empty.
 */

import { mkdirSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { StartupRowsPayload } from "@minimal-agent/core/plugin-api"

import { resetEngine } from "../handlers/dispatch.ts"

import { makeSandbox, nativeConfig, type Sandbox } from "./test-support.ts"

const PLUGIN_DIR = resolve(import.meta.dir, "..")
const ENV_KEYS = ["HOME", "MINIMAL_AGENT_HOME", "MINIMAL_AGENT_CONFIG", "MA_TRUST_HOOKS"] as const

let sb: Sandbox | undefined
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

afterEach(() => {
  resetEngine()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  sb?.cleanup()
  sb = undefined
})

/** Temp HOME, then a real loader whose only root holds this plugin. */
async function boot(s: Sandbox): Promise<PluginLoader> {
  process.env.HOME = s.home
  delete process.env.MINIMAL_AGENT_HOME
  delete process.env.MINIMAL_AGENT_CONFIG
  delete process.env.MA_TRUST_HOOKS
  const root = join(s.root, "plugins")
  mkdirSync(root, { recursive: true })
  symlinkSync(PLUGIN_DIR, join(root, "ma-hooks-plugin"))
  resetEngine()
  return PluginLoader.load({ roots: { user: [root] }, logger: () => {} })
}

describe("real PluginLoader + startup.rows", () => {
  test("one native hook yields one hooks row", async () => {
    sb = makeSandbox()
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("turn.willStart", ["/bin/a.sh"]))
    const loader = await boot(sb)
    const channels = loader.getHookSubs().map((x) => x.sub.definition.channel)
    expect(channels).toContain("startup.rows")
    const r = await loader
      .hooks()
      .emitChain("startup.rows", { cwd: sb.project, cols: 100, rows: [] })
    const rows = (r.payload as StartupRowsPayload).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]?.label).toBe("hooks")
    expect(rows[0]?.summary).toEqual([{ text: "1 active", tone: "ok" }])
  })

  test("no hooks leaves rows empty", async () => {
    sb = makeSandbox()
    const loader = await boot(sb)
    const r = await loader
      .hooks()
      .emitChain("startup.rows", { cwd: sb.project, cols: 100, rows: [] })
    expect((r.payload as StartupRowsPayload).rows).toEqual([])
  })
})
