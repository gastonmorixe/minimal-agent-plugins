import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"

import type { StartupRow, StartupRowsPayload } from "../engine/startup-row.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "../engine/test-support.ts"
import manifest from "../manifest.json"

import { engineFor, resetEngine } from "./dispatch.ts"
import startupRows from "./startup-rows.ts"

let sb: Sandbox | undefined
const saved = {
  HOME: process.env.HOME,
  MINIMAL_AGENT_HOME: process.env.MINIMAL_AGENT_HOME,
  MA_TRUST_HOOKS: process.env.MA_TRUST_HOOKS,
}

function restore(key: keyof typeof saved): void {
  const v = saved[key]
  if (v === undefined) delete process.env[key]
  else process.env[key] = v
}

afterEach(() => {
  sb?.cleanup()
  sb = undefined
  resetEngine()
  restore("HOME")
  restore("MINIMAL_AGENT_HOME")
  restore("MA_TRUST_HOOKS")
})

function ctx(cwd: string, debugs: string[] = []): HookHandlerContext {
  const noop = () => {}
  return {
    channel: "startup.rows",
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
      debug: (_src: string, msg: string) => {
        debugs.push(msg)
      },
    },
  } as HookHandlerContext
}

/** Temp HOME with no MINIMAL_AGENT_HOME override. */
function homeSandbox(): Sandbox {
  const s = makeSandbox()
  process.env.HOME = s.home
  delete process.env.MINIMAL_AGENT_HOME
  delete process.env.MA_TRUST_HOOKS
  return s
}

const TOOLS: StartupRow = { label: "tools", summary: [{ text: "ShowDiff" }] }

describe("startup.rows handler", () => {
  test("appends the hooks row from a temp HOME (native + claude)", () => {
    sb = homeSandbox()
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("tool.willInvoke", ["/bin/guard.sh"], {}, "Bash"),
    )
    sb.write(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x.sh" }] }] } }),
    )
    const payload: StartupRowsPayload = { cwd: sb.project, cols: 80, rows: [TOOLS] }
    const r = startupRows(payload, ctx("/elsewhere"))
    expect(r?.payload.cwd).toBe(sb.project)
    expect(r?.payload.cols).toBe(80)
    expect(r?.payload.rows[0]).toBe(TOOLS)
    expect(r?.payload.rows[1]).toEqual({
      label: "hooks",
      summary: [{ text: "2 active", tone: "ok" }],
      children: [
        { label: "tool.willInvoke", value: [{ text: "Bash → guard.sh", tone: "accent" }] },
        {
          label: "turn.willStop",
          value: [{ text: "x.sh", tone: "accent" }, { text: "claude" }],
        },
      ],
    })
    // The input payload is not mutated.
    expect(payload.rows).toEqual([TOOLS])
  })

  test("uses the dispatch engine cache for payload.cwd", () => {
    sb = homeSandbox()
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("turn.willStart", ["a.sh"]))
    startupRows({ cwd: sb.project, cols: 80, rows: [] }, ctx(sb.project))
    const eng = engineFor(sb.project)
    expect(engineFor(sb.project)).toBe(eng)
    expect(eng.all).toHaveLength(1)
  })

  test("no hooks returns undefined", () => {
    sb = homeSandbox()
    expect(startupRows({ cwd: sb.project, cols: 80, rows: [TOOLS] }, ctx(sb.project))).toBe(
      undefined,
    )
  })

  test("never throws: a bad payload is logged at debug and returns undefined", () => {
    sb = homeSandbox()
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("turn.willStart", ["a.sh"]))
    const debugs: string[] = []
    const bad = { cwd: sb.project, cols: 80, rows: [] } as StartupRowsPayload
    Object.defineProperty(bad, "rows", {
      get() {
        throw new Error("boom")
      },
    })
    expect(startupRows(bad, ctx(sb.project, debugs))).toBeUndefined()
    expect(debugs.join("\n")).toContain("boom")
    expect(startupRows(null as unknown as StartupRowsPayload, ctx(sb.project))).toBeUndefined()
  })

  test("manifest does not register startup.rows yet", () => {
    expect(JSON.stringify(manifest)).not.toContain("startup.rows")
  })
})
