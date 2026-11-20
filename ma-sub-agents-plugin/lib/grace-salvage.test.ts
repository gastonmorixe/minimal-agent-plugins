/**
 * Tests for the review-2 fixes of the grace phase: the salvage in the digest
 * and the linked task (MAJ-2), the probe read order (MIN-1), the salvage clip
 * (MIN-2), and the "stopping" note in AgentStatus and ListAgents (MIN-4).
 *
 * @module sub-agents/lib/grace-salvage.test
 */

import { describe, expect, it } from "bun:test"

import { resultText, statusDetail } from "./content.ts"
import { renderFleetDisplay } from "./render.ts"
import { probeWorker } from "./spawn.ts"
import { parseStream } from "./stream.ts"
import {
  completionDigest,
  DEFAULT_GRACE_SEC,
  type Effect,
  SALVAGED_TASK_NOTE,
  supervisorTick,
  type WorkerProbe,
} from "./supervisor.ts"
import { SALVAGE_MAX_CHARS, type SubagentRecord, sessionId, subagentId } from "./types.ts"

const NOW_MS = Date.parse("2026-05-30T12:00:00.000Z")
const TIMEOUT = "timed out (budget deadline exceeded)"

function late(extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: subagentId("A1"),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label: "explorer",
    type: "explorer",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: new Date(NOW_MS).toISOString(),
    status: {
      kind: "running",
      pid: 4242,
      startedAt: new Date(NOW_MS - 120_000).toISOString(),
      progress: { tools: 0, tokens: 0 },
    },
    depth: 1,
    leadSid: sessionId("ba0ad20f-1111-4111-8111-111111111111"),
    budget: { deadlineSec: 60 },
    ...extra,
  }
}

function tick(records: readonly SubagentRecord[], probe: WorkerProbe | undefined, nowMs: number) {
  const probes = new Map<string, WorkerProbe>(probe ? [["A1", probe]] : [])
  return supervisorTick({ records, probes, now: new Date(nowMs).toISOString(), nowMs })
}

/** Trip the deadline (SIGTERM), then end the run with text only. */
function failWithSalvage(r: SubagentRecord, distilled = "partial findings") {
  const first = tick([r], { alive: true }, NOW_MS)
  return tick(first.records, { alive: true, runEnded: true, distilled }, NOW_MS + 5_000)
}

const injectText = (effects: readonly Effect[]): string => {
  const e = effects.find((x) => x.type === "inject")
  return e?.type === "inject" ? e.text : ""
}

describe("MAJ-2: a failed worker with salvage tells the lead", () => {
  it("the digest says that the final message was salvaged and names AgentResult", () => {
    const out = failWithSalvage(late())
    const text = injectText(out.effects)
    expect(text).toContain(`failed: ${TIMEOUT}.`)
    expect(text).toContain("final message was salvaged")
    expect(text).toContain("SubAgentsAgentResult A1")
  })

  it("the digest of a failure with no salvage stays short", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: true }, NOW_MS + DEFAULT_GRACE_SEC * 1000)
    const text = injectText(out.effects)
    expect(text).toBe(`Sub-agent A1 (explorer) failed: ${TIMEOUT}.`)
  })

  it("the linked task stays canceled, and its reason tells about the salvage", () => {
    const out = failWithSalvage(late({ taskId: "3" }))
    const update = out.effects.find((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")
    expect(update?.type === "emit" && update.payload).toEqual({
      taskId: "3",
      status: "canceled",
      reason: `${TIMEOUT}${SALVAGED_TASK_NOTE}`,
      bySubagent: subagentId("A1"),
    })
    expect(SALVAGED_TASK_NOTE).toBe(" (final message salvaged; read it with SubAgentsAgentResult)")
    expect(injectText(out.effects)).toContain("Linked task 3 was automatically canceled")
  })

  it("completionDigest of a failed record with no salvage has no salvage words", () => {
    const r = late()
    const text = completionDigest({
      ...r,
      status: { kind: "failed", endedAt: "t", error: "boom" },
    })
    expect(text).not.toContain("salvaged")
  })
})

describe("MIN-1: probeWorker reads the stream before the sentinel", () => {
  const ENDED = parseStream(
    `${JSON.stringify({ type: "result", outcome: "truncated", text: "wrap-up text" })}\n`,
  )

  it("a sentinel written between the two reads is seen", () => {
    // Simulate the race: the worker writes its sentinel, then the stream end.
    // The stream read sees the end, so the sentinel must be on disk too.
    const calls: string[] = []
    let sentinelOnDisk = false
    const probe = probeWorker(
      { pid: 7, resultPath: "/r.json", transcriptPath: "/t.jsonl", streamPath: "/s.ndjson" },
      {
        pidAlive: () => true,
        readStream: () => {
          calls.push("stream")
          sentinelOnDisk = true // written before `result` reached the stream
          return ENDED
        },
        readResult: () => {
          calls.push("sentinel")
          return sentinelOnDisk ? { short: "reported", tokens: 1, tools: 1 } : undefined
        },
      },
    )
    expect(calls).toEqual(["stream", "sentinel"])
    expect(probe.runEnded).toBe(true)
    expect(probe.result?.short).toBe("reported")
  })

  it("in the grace, that probe finishes done, not failed", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const probe: WorkerProbe = {
      alive: true,
      runEnded: true,
      result: { short: "reported", tokens: 1, tools: 1 },
    }
    const out = tick(first.records, probe, NOW_MS + 5_000)
    expect(out.records[0]?.status.kind).toBe("done")
  })
})

describe("MIN-2: the salvage clip", () => {
  const exited = (text: string) =>
    probeWorker(
      { pid: 7, resultPath: "/r.json", transcriptPath: "/t.jsonl", streamPath: "/s.ndjson" },
      {
        pidAlive: () => false,
        readResult: () => undefined,
        readStream: () =>
          parseStream(`${JSON.stringify({ type: "result", outcome: "truncated", text })}\n`),
      },
    )

  it("keeps up to SALVAGE_MAX_CHARS (8000) characters with no clip mark", () => {
    expect(SALVAGE_MAX_CHARS).toBe(8000)
    const text = "x".repeat(5000)
    const probe = exited(text)
    expect(probe.distilled).toBe(text)
    expect(probe.distilledClipped).toBeUndefined()
  })

  it("clips a longer text at SALVAGE_MAX_CHARS and marks it", () => {
    const probe = exited("y".repeat(SALVAGE_MAX_CHARS + 500))
    expect(probe.distilled?.length).toBe(SALVAGE_MAX_CHARS)
    expect(probe.distilled?.endsWith("…")).toBe(true)
    expect(probe.distilledClipped).toBe(true)
  })

  it("AgentResult says when the salvage is clipped", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const long = `${"z".repeat(SALVAGE_MAX_CHARS - 1)}…`
    const probe: WorkerProbe = {
      alive: true,
      runEnded: true,
      distilled: long,
      distilledClipped: true,
    }
    const out = tick(first.records, probe, NOW_MS + 5_000)
    const r = out.records[0]
    expect(r?.status.kind === "failed" && r.status.salvageClipped).toBe(true)
    if (!r) return
    expect(resultText(r)).toContain(`clipped at ${SALVAGE_MAX_CHARS} characters`)
  })

  it("AgentResult has no clip note for a short salvage", () => {
    const r = failWithSalvage(late()).records[0]
    if (!r) throw new Error("no record")
    expect(resultText(r)).not.toContain("clipped")
  })
})

describe("MIN-4: AgentStatus and ListAgents show the grace", () => {
  const inGrace = (): SubagentRecord => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const r = first.records[0]
    if (!r) throw new Error("no record")
    return r
  }

  it("the AgentStatus text says stopping, the limit, and the time left", () => {
    const text = statusDetail(inGrace(), NOW_MS + 18_000)
    expect(text).toContain(`stopping (limit: ${TIMEOUT}, SIGKILL in 42s)`)
  })

  it("the list row says stopping with the time left", () => {
    const { body } = renderFleetDisplay([inGrace()], false, NOW_MS + 18_000)
    expect(body).toContain("stopping · SIGKILL in 42s")
  })

  it("a normal running worker shows no stopping note", () => {
    const r = late({ budget: { deadlineSec: 3600 } })
    expect(statusDetail(r, NOW_MS)).not.toContain("stopping")
    expect(renderFleetDisplay([r], false, NOW_MS).body).not.toContain("stopping")
  })

  it("AgentResult of a worker in the grace says that it is stopping", () => {
    expect(resultText(inGrace())).toContain("stopping")
  })
  it("names the effort in the status line when the record has one", () => {
    expect(statusDetail({ ...inGrace(), effort: "high" }, NOW_MS)).toContain("· effort high ·")
  })
  it("omits effort when the record has none", () => {
    expect(statusDetail(inGrace(), NOW_MS)).not.toContain("effort")
  })
})
