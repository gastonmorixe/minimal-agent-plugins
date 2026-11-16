/**
 * Per-session async limiter and abort (review MAJOR 1), and the plugin
 * config file in the reload signature (review MINOR 3).
 */

import { readdirSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { makeSandbox, nativeConfig, type Sandbox } from "../engine/test-support.ts"

import dispatch, { asyncQueue, resetEngine } from "./dispatch.ts"

let sb: Sandbox | undefined
const saved = {
  HOME: process.env.HOME,
  MINIMAL_AGENT_HOME: process.env.MINIMAL_AGENT_HOME,
  MINIMAL_AGENT_CONFIG: process.env.MINIMAL_AGENT_CONFIG,
}

function restore(key: keyof typeof saved): void {
  if (saved[key] === undefined) delete process.env[key]
  else process.env[key] = saved[key]
}

afterEach(() => {
  resetEngine()
  sb?.cleanup()
  sb = undefined
  restore("HOME")
  restore("MINIMAL_AGENT_HOME")
  restore("MINIMAL_AGENT_CONFIG")
})

function homeSandbox(): Sandbox {
  const s = makeSandbox()
  process.env.HOME = s.home
  delete process.env.MINIMAL_AGENT_HOME
  delete process.env.MINIMAL_AGENT_CONFIG
  delete process.env.MA_TRUST_HOOKS
  return s
}

function ctx(channel: string, cwd: string, sessionId: string): HookHandlerContext {
  const noop = () => {}
  return {
    agent: { sessionId, pid: 1, model: "m", version: "0" },
    channel,
    packageDir: "/pkg",
    cwd,
    env: {},
    abort: new AbortController().signal,
    priority: 50,
    emit: noop,
    log: {
      emergency: noop,
      alert: noop,
      critical: noop,
      error: noop,
      warn: noop,
      notice: noop,
      info: noop,
      debug: noop,
    },
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await Bun.sleep(20)
  }
  return cond()
}

function config(plugin: Record<string, unknown>): string {
  return JSON.stringify({ plugins: { hooks: plugin } })
}

describe("async hooks: one limiter per session (MAJOR 1)", () => {
  test("two sessions each run maxAsync jobs at the same time (no shared cap)", async () => {
    sb = homeSandbox()
    sb.write(join(sb.agentHome, "config.jsonc"), config({ maxAsync: 2 }))
    const s = sb.script("slow.sh", "cat > /dev/null; sleep 0.4; echo async-done")
    const hooks = Array.from({ length: 3 }, (_, i) => ({ command: `${s} ${i}`, async: true }))
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("turn.willStart", hooks))
    await dispatch({ text: "a" }, ctx("turn.willStart", sb.project, "S1"))
    await dispatch({ text: "a" }, ctx("turn.willStart", sb.project, "S2"))
    const q = asyncQueue()
    expect(q).not.toBeNull()
    await q?.idle()
    expect(q?.peak).toBe(2)
    expect(q?.peakTotal).toBe(4)
    expect(q?.drain("S1")).toEqual(Array(3).fill("async-done"))
    expect(q?.drain("S2")).toEqual(Array(3).fill("async-done"))
  })

  test("agent.willStop of a session kills its running async hook quickly, not the other", async () => {
    sb = homeSandbox()
    const dir = join(sb.root, "pids")
    const s = sb.script(
      "hang.sh",
      `cat > /dev/null; mkdir -p ${dir}; echo > ${dir}/$$; exec sleep 30`,
    )
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("turn.willStart", [{ command: s, async: true }]),
    )
    const pids = () => {
      try {
        return readdirSync(dir).map(Number)
      } catch {
        return []
      }
    }
    await dispatch({ text: "a" }, ctx("turn.willStart", sb.project, "S1"))
    expect(await until(() => pids().length === 1)).toBe(true)
    const [p1 = 0] = pids()
    await dispatch({ text: "a" }, ctx("turn.willStart", sb.project, "S2"))
    expect(await until(() => pids().length === 2)).toBe(true)
    const p2 = pids().find((p) => p !== p1) ?? 0
    expect(alive(p1) && alive(p2)).toBe(true)

    const started = Date.now()
    await dispatch({}, ctx("agent.willStop", sb.project, "S1"))
    expect(await until(() => !alive(p1), 2000)).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(alive(p2)).toBe(true)

    // An engine reset (dispose or rebuild) aborts the other session too.
    resetEngine()
    expect(await until(() => !alive(p2), 2000)).toBe(true)
  })
})

describe("plugin config in the reload signature (MINOR 3)", () => {
  test("adapters.claude=false is seen at the next dispatch", async () => {
    sb = homeSandbox()
    const script = sb.script("ctx.sh", "cat > /dev/null; echo claude-ctx")
    sb.write(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: script }] }] },
      }),
    )
    const p = { text: "hi" }
    const r1 = await dispatch(p, ctx("turn.willStart", sb.project, "S1"))
    expect(r1).toMatchObject({ additionalContext: ["claude-ctx"] })
    sb.write(join(sb.agentHome, "config.jsonc"), config({ adapters: { claude: false } }))
    expect(await dispatch(p, ctx("turn.willStart", sb.project, "S1"))).toBeUndefined()
  })

  test("a MINIMAL_AGENT_CONFIG file change is seen too (enabled=false)", async () => {
    sb = homeSandbox()
    const cfg = join(sb.root, "custom.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = cfg
    sb.write(cfg, config({ enabled: true }))
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("turn.willStart", ["echo on"]))
    const p = { text: "hi" }
    expect(await dispatch(p, ctx("turn.willStart", sb.project, "S1"))).toMatchObject({
      additionalContext: ["on"],
    })
    sb.write(cfg, config({ enabled: false, note: "changed" }))
    expect(await dispatch(p, ctx("turn.willStart", sb.project, "S1"))).toBeUndefined()
  })
})
