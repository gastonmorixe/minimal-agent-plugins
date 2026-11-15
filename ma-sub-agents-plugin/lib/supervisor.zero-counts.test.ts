/**
 * Regression: a fast worker that writes its sentinel before any supervisor
 * tick saw it running showed `done · 0 tok · 0 tools` (lead 0c54da75, worker
 * c85b5171: 8 tool calls, 61,339 context tokens on disk).
 *
 * Causes:
 * 1. ReportResult writes `tokens: 0, tools: 0` when the model passes no counts.
 *    The supervisor used those zeros as-is for `done`.
 * 2. The probe read the transcript only while alive, and the sentinel tick
 *    did not use the progress it carried.
 */
import { describe, expect, it } from "bun:test"

import { probeWorker } from "./spawn.ts"
import { supervisorTick, type WorkerProbe } from "./supervisor.ts"
import { type Progress, type SubagentRecord, sessionId, subagentId } from "./types.ts"

const NOW = "2026-11-15T19:32:10.000Z"
const NOW_MS = Date.parse(NOW)
const DISK: Progress = { tools: 8, tokens: 61_339, lastTool: "SubAgentsReportResult" }

function runningRec(progress: Progress = { tools: 0, tokens: 0 }): SubagentRecord {
  return {
    id: subagentId("A1"),
    sid: sessionId("c85b5171-f937-4e71-9c91-44a02b369d29"),
    label: "news-search",
    type: "worker",
    model: "claude-opus-5-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: NOW,
    status: { kind: "running", pid: 97195, startedAt: NOW, progress },
    depth: 1,
    leadSid: sessionId("0c54da75-9681-4a82-a508-ec96ad8c6bf9"),
  }
}

function tick(r: SubagentRecord, probe: WorkerProbe) {
  return supervisorTick({ records: [r], probes: new Map([["A1", probe]]), now: NOW, nowMs: NOW_MS })
}

describe("done counts when the sentinel lands before any progress tick", () => {
  it("uses the probe's progress when the sentinel reports zero counts", () => {
    const out = tick(runningRec(), {
      alive: true,
      progress: DISK,
      result: { short: "briefing", tokens: 0, tools: 0 },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") {
      expect(st.result.tokens).toBe(61_339)
      expect(st.result.tools).toBe(8)
    }
  })

  it("uses the last live progress when the exit probe has none", () => {
    const out = tick(runningRec(DISK), {
      alive: false,
      exitCode: 0,
      result: { short: "briefing", tokens: 0, tools: 0 },
    })
    const st = out.records[0]?.status
    if (st?.kind === "done") expect(st.result.tools).toBe(8)
    else throw new Error(`expected done, got ${st?.kind}`)
  })

  it("keeps counts the worker reported itself when they are larger", () => {
    const out = tick(runningRec(), {
      alive: true,
      progress: DISK,
      result: { short: "briefing", tokens: 90_000, tools: 12 },
    })
    const st = out.records[0]?.status
    if (st?.kind === "done") {
      expect(st.result.tokens).toBe(90_000)
      expect(st.result.tools).toBe(12)
    } else throw new Error(`expected done, got ${st?.kind}`)
  })
})

describe("probeWorker reads progress after exit too", () => {
  it("returns transcript progress for a dead worker", () => {
    const probe = probeWorker(
      { pid: 1, resultPath: "r", transcriptPath: "t" },
      {
        pidAlive: () => false,
        readResult: () => ({ short: "briefing", tokens: 0, tools: 0 }),
        readProgress: () => DISK,
      },
    )
    expect(probe.progress).toEqual(DISK)
  })
})
