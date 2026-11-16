/**
 * 15e.2 fix: the SpawnAgent tool_result text of a `subagent.willSpawn` deny.
 * The plugin reason wins; a failClosed listener failure names the hook.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderFor } from "../../tests/support/prompt-render.ts"

import { type ServiceDeps, spawnAgent, spawnBlockedText } from "./service.ts"
import { SubagentStore } from "./store.ts"
import { sessionId } from "./types.ts"

const testRender = renderFor("ma-sub-agents-plugin", `${import.meta.dirname}/..`)
const LEAD = sessionId("11111111-1111-4111-8111-111111111111")

function makeDeps(
  dir: string,
  over: Partial<ServiceDeps> = {},
): ServiceDeps & { launched: string[][] } {
  const launched: string[][] = []
  return {
    store: new SubagentStore(LEAD, { dir }),
    spawnDeps: {
      launch: (argv) => {
        launched.push([...argv])
        return 5000 + launched.length
      },
    },
    agentBin: ["minimal-agent"],
    leadSid: LEAD,
    depth: 0,
    cwd: "/repo",
    sessionsDir: dir,
    defaultModel: "claude-sonnet-4-6",
    newSid: () => "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978",
    now: () => new Date("2026-05-30T12:00:00.000Z"),
    launched,
    renderPrompt: testRender,
    ...over,
  }
}

describe("spawnAgent subagent.willSpawn deny text", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-willspawn-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("subagent.willSpawn deny: the plugin reason reaches the tool_result", async () => {
    const deps = makeDeps(dir, {
      emitChain: async <T>(_c: string, payload: T) => ({
        payload,
        halted: true,
        reason: " no spawns ",
      }),
    })
    const r = await spawnAgent({ task: "x" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("no spawns")
    expect(deps.launched.length).toBe(0)
  })

  it("subagent.willSpawn failClosed failure: the tool_result names the failed approval hook", async () => {
    const deps = makeDeps(dir, {
      emitChain: async <T>(_c: string, payload: T) => ({
        payload,
        halted: true,
        failed: true,
        failure: { label: "guard", detail: "timed out" },
      }),
    })
    const r = await spawnAgent({ task: "x" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe(
        'Sub-agent spawn blocked by lifecycle policy hook (approval hook "guard" failed (timed out)).',
      )
    }
    expect(deps.launched.length).toBe(0)
  })

  it("subagent.willSpawn deny with no reason and no failure keeps the generic text", async () => {
    const deps = makeDeps(dir, {
      emitChain: async <T>(_c: string, payload: T) => ({ payload, halted: true }),
    })
    const r = await spawnAgent({ task: "x" }, deps)
    if (!r.ok) expect(r.error).toBe("Sub-agent spawn blocked by lifecycle policy hook.")
    else throw new Error("expected a deny")
  })

  it("spawnBlockedText: a failure with no label names the approval hook", () => {
    expect(spawnBlockedText(undefined, { detail: "boom" })).toBe(
      "Sub-agent spawn blocked by lifecycle policy hook (approval hook failed (boom)).",
    )
  })
})
