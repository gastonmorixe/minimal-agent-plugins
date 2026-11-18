/** Spawn-level tests for the target control channel: what a new worker gets. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderFor } from "../../tests/support/prompt-render.ts"

import { type ServiceDeps, spawnAgent } from "./service.ts"
import { SubagentStore } from "./store.ts"
import { resetLeadControlForTests } from "./target-control-lead.ts"
import { sessionId } from "./types.ts"

const LEAD = sessionId("11111111-1111-4111-8111-111111111111")
const FIXED_SID = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"

function makeDeps(dir: string, over: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    store: new SubagentStore(LEAD, { dir }),
    spawnDeps: { launch: () => 5001 },
    agentBin: ["minimal-agent"],
    leadSid: LEAD,
    depth: 0,
    cwd: "/repo",
    sessionsDir: dir,
    defaultModel: "claude-sonnet-4-6",
    newSid: () => FIXED_SID,
    now: () => new Date("2026-05-30T12:00:00.000Z"),
    renderPrompt: renderFor("ma-sub-agents-plugin", `${import.meta.dirname}/..`),
    ...over,
  }
}

describe("spawnAgent: target control channel", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-control-"))
    resetLeadControlForTests()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetLeadControlForTests()
  })

  it("gives the worker its target control file and key, and saves the key id (not the key)", async () => {
    const envs: Record<string, string>[] = []
    const deps = makeDeps(dir, {
      spawnDeps: {
        launch: (_argv, opts) => {
          envs.push(opts.env)
          return 7001
        },
      },
    })
    const r = await spawnAgent({ task: "work" }, deps)
    expect(r.ok).toBe(true)
    const env = envs[0] ?? {}
    expect(env.MINIMAL_AGENT_TARGET_CONTROL_FILE).toBe(`${dir}/${FIXED_SID}.control.jsonl`)
    expect(env.MINIMAL_AGENT_TARGET_CONTROL_KEY).toMatch(/^[0-9a-f]{64}$/)
    const record = deps.store.all()[0]
    expect(record?.controlKeyId).toMatch(/^[0-9a-f]{16}$/)
    // The fleet file on disk never has the key.
    expect(readFileSync(deps.store.filePath(), "utf8")).not.toContain(
      env.MINIMAL_AGENT_TARGET_CONTROL_KEY ?? "missing",
    )
  })

  it("a control setup failure does not stop the spawn: the worker starts with no control channel", async () => {
    const envs: Record<string, string>[] = []
    const warnings: string[] = []
    const deps = makeDeps(dir, {
      newSid: () => "bad id with spaces",
      warn: (m) => warnings.push(m),
      spawnDeps: {
        launch: (_argv, opts) => {
          envs.push(opts.env)
          return 7002
        },
      },
    })
    const r = await spawnAgent({ task: "work" }, deps)
    expect(r.ok).toBe(true)
    expect(envs).toHaveLength(1)
    expect("MINIMAL_AGENT_TARGET_CONTROL_FILE" in (envs[0] ?? {})).toBe(false)
    expect("MINIMAL_AGENT_TARGET_CONTROL_KEY" in (envs[0] ?? {})).toBe(false)
    expect(deps.store.all()[0]?.controlKeyId).toBeUndefined()
    expect(warnings.filter((w) => w.includes("no target control channel"))).toHaveLength(1)
  })
})
