/**
 * A stopped worker keeps the spend of its last progress, so the fleet sum
 * (`fleetStats`) does not lose it. A worker that never ran has no spend.
 *
 * @module sub-agents/lib/service.stop-spend.test
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { stopAgent, stopAllAgents } from "./service.ts"
import { SubagentStore } from "./store.ts"
import { type SubagentStatus, sessionId, subagentId } from "./types.ts"

const LEAD = sessionId("ba0ad20f-1111-4111-8111-111111111111")
const COUNTS = { tokens: 187_000, tools: 12, output: 58_100, thinking: 33_100, turns: 9 }
const RUNNING: SubagentStatus = {
  kind: "running",
  pid: 4242,
  startedAt: "2026-05-30T12:00:00.000Z",
  progress: { ...COUNTS, lastTool: "Bash" },
}

describe("stop keeps the spend of a running worker", () => {
  let dir: string
  let store: SubagentStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-stopspend-"))
    store = new SubagentStore(LEAD, { dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const seed = (status: SubagentStatus) =>
    store.upsert({
      id: subagentId("A1"),
      sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
      label: "worker",
      type: "worker",
      model: "cursor-auto",
      task: "long job",
      isolation: "fresh",
      workspace: "inherit-cwd",
      spawnedAt: "2026-05-30T12:00:00.000Z",
      status,
      depth: 1,
      leadSid: LEAD,
    })
  const deps = () => ({
    store,
    kill: () => {},
    now: () => new Date("2026-05-30T12:05:00.000Z"),
  })

  it("stopAgent copies the progress spend onto the stopped status", () => {
    seed(RUNNING)
    expect(stopAgent("A1", "superseded", deps()).ok).toBe(true)
    expect(store.get("A1")?.status).toEqual({
      kind: "stopped",
      endedAt: "2026-05-30T12:05:00.000Z",
      reason: "superseded",
      ...COUNTS,
    })
  })

  it("stopAllAgents copies the progress spend onto the stopped status", () => {
    seed(RUNNING)
    stopAllAgents("lead shutting down", deps())
    expect(store.get("A1")?.status).toMatchObject({ kind: "stopped", ...COUNTS })
  })

  it("a queued worker stops with no spend fields", () => {
    seed({ kind: "queued" })
    stopAgent("A1", undefined, deps())
    const st = store.get("A1")?.status
    expect(st?.kind).toBe("stopped")
    expect(st && "tokens" in st).toBe(false)
  })
})
