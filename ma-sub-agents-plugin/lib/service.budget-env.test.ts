/**
 * The lead gives the worker its effective budget and its start time in the
 * env, so that the worker-side stamp stage can warn before the deadline.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderFor } from "../../tests/support/prompt-render.ts"

import { type ServiceDeps, spawnAgent } from "./service.ts"
import { ENV_BUDGET, ENV_STARTED_AT } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { sessionId } from "./types.ts"

const testRender = renderFor("ma-sub-agents-plugin", `${import.meta.dirname}/..`)
const LEAD = sessionId("11111111-1111-4111-8111-111111111111")
const NOW = "2026-05-30T12:00:00.000Z"

function makeDeps(dir: string, envs: Record<string, string>[]): ServiceDeps {
  let n = 0
  return {
    store: new SubagentStore(LEAD, { dir }),
    spawnDeps: {
      launch: (_argv, opts) => {
        envs.push(opts.env)
        return 7000 + envs.length
      },
    },
    agentBin: ["minimal-agent"],
    leadSid: LEAD,
    depth: 0,
    cwd: "/repo",
    sessionsDir: dir,
    defaultModel: "claude-sonnet-4-6",
    newSid: () => `9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a697${n++}`,
    now: () => new Date(NOW),
    renderPrompt: testRender,
  }
}

describe("spawnAgent budget env", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-budget-env-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("passes the explicit budget and the start time to the worker env", async () => {
    const envs: Record<string, string>[] = []
    await spawnAgent({ task: "t", budget: { deadlineSec: 300, maxTurns: 12 } }, makeDeps(dir, envs))
    expect(JSON.parse(envs[0]?.[ENV_BUDGET] ?? "null")).toEqual({ deadlineSec: 300, maxTurns: 12 })
    expect(envs[0]?.[ENV_STARTED_AT]).toBe(NOW)
  })

  it("passes the 1800 s supervisor default when the spawn has no budget", async () => {
    const envs: Record<string, string>[] = []
    await spawnAgent({ task: "t" }, makeDeps(dir, envs))
    expect(JSON.parse(envs[0]?.[ENV_BUDGET] ?? "null")).toEqual({ deadlineSec: 1800 })
  })
})
