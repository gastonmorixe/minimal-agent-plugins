import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { nativeAdapter } from "../native/adapter.ts"

import { AsyncHookQueue } from "./async-queue.ts"
import { loadHooksConfig, parseHooksConfig } from "./config.ts"
import { mergeResults } from "./merge.ts"
import { capText } from "./output-cap.ts"
import { DIALECT_ADAPTERS, selectAdapters } from "./registry.ts"
import { makeSandbox, type Sandbox } from "./test-support.ts"
import type { HookDialectAdapter } from "./types.ts"

let sb: Sandbox | undefined
afterEach(() => {
  sb?.cleanup()
  sb = undefined
})

describe("config", () => {
  test("defaults: on, claude adapter on, caps", () => {
    const c = parseHooksConfig({})
    expect(c).toEqual({
      enabled: true,
      adapters: { claude: true },
      adapterOrder: ["claude"],
      stopBlockCap: 8,
      maxAsync: 8,
      outputCapChars: 10_000,
    })
  })

  test("reads plugins.hooks from a temp HOME config.jsonc", () => {
    sb = makeSandbox()
    sb.write(
      join(sb.agentHome, "config.jsonc"),
      '{ // x\n "plugins": { "hooks": { "adapters": { "claude": false }, "maxAsync": 3 } } }',
    )
    const c = loadHooksConfig({ HOME: sb.home })
    expect(c.adapters.claude).toBe(false)
    expect(c.maxAsync).toBe(3)
  })

  test("MINIMAL_AGENT_CONFIG wins, a broken file gives defaults", () => {
    sb = makeSandbox()
    const p = sb.write("cfg.json", "{ broken")
    expect(loadHooksConfig({ HOME: sb.home, MINIMAL_AGENT_CONFIG: p }).enabled).toBe(true)
  })
})

describe("registry", () => {
  const stub = (id: string): HookDialectAdapter => ({ ...nativeAdapter, id, authoritative: false })

  test("native is always first, then enabled adapters in order", () => {
    const cfg = { ...parseHooksConfig({}), adapterOrder: ["b", "a"] }
    expect(selectAdapters(cfg, [stub("a"), stub("b")]).map((a) => a.id)).toEqual([
      "native",
      "b",
      "a",
    ])
  })

  test("an adapter switched off is left out", () => {
    const cfg = { ...parseHooksConfig({}), adapters: { claude: false } }
    expect(selectAdapters(cfg, [stub("claude")]).map((a) => a.id)).toEqual(["native"])
  })

  test("the shipped registry holds no adapter that imports native as its own id", () => {
    expect(DIALECT_ADAPTERS.every((a) => a.id !== "native")).toBe(true)
  })
})

describe("merge", () => {
  test("deny > ask > allow, reasons of the winner", () => {
    const m = mergeResults([
      { decision: "allow", context: ["a"] },
      { decision: "ask", reason: "q", context: [] },
      { decision: "deny", reason: "d", context: ["b"] },
    ])
    expect(m.decision).toBe("deny")
    expect(m.reasons).toEqual(["d"])
    expect(m.context).toEqual(["a", "b"])
  })
})

describe("async queue", () => {
  test("never exceeds max", async () => {
    const q = new AsyncHookQueue(3)
    for (let i = 0; i < 10; i++) {
      q.push(async () => {
        await Bun.sleep(10)
        return [`r${i}`]
      })
    }
    await q.idle()
    expect(q.peak).toBe(3)
    expect(q.drain().length).toBe(10)
    expect(q.drain()).toEqual([])
  })
})

describe("output cap", () => {
  test("short text unchanged, long text gets a preview", () => {
    expect(capText("abc", 10)).toBe("abc")
    const c = capText("x".repeat(5000), 1000)
    expect(c.startsWith("x".repeat(2000))).toBe(true)
    expect(c).toContain("5000 chars, not saved")
  })
})
