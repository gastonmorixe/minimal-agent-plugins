/**
 * `/hooks list` row cap (B2 review minor).
 */

import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { HooksEngine } from "../engine/engine.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "../engine/test-support.ts"
import { nativeAdapter } from "../native/adapter.ts"

import { LIST_MAX_HOOKS, listLines } from "./hooks-command.ts"

let sb: Sandbox

beforeEach(() => {
  sb = makeSandbox()
})

afterEach(() => {
  sb.cleanup()
})

function engineWith(n: number): HooksEngine {
  const cmds = Array.from({ length: n }, (_, i) => `echo hook-${i}`)
  sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("tool.before", cmds))
  return new HooksEngine({ cwd: sb.project, env: sb.env, adapters: [nativeAdapter] })
}

/** Lines that open one hook entry (the trust key line). */
const hookRows = (lines: string[]) => lines.filter((l) => /^ {2}\S/.test(l))

describe("/hooks list cap", () => {
  test("default cap is 200 hooks", () => {
    expect(LIST_MAX_HOOKS).toBe(200)
  })

  test("more hooks than the cap: shows the cap, then one '... N more' line", () => {
    const e = engineWith(5)
    expect(e.all.length).toBe(5)
    const lines = listLines(e, 3)
    expect(hookRows(lines)).toHaveLength(3)
    expect(lines.at(-1)).toBe("... 2 more")
  })

  test("within the cap: no '... more' line", () => {
    const e = engineWith(2)
    const lines = listLines(e, 3)
    expect(hookRows(lines)).toHaveLength(2)
    expect(lines.some((l) => l.startsWith("..."))).toBe(false)
  })
})
