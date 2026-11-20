/**
 * Tests for the grace phase at a limit (deadline, maxTurns, maxTokens): the
 * supervisor sends SIGTERM once, keeps the worker `running` with a `grace`
 * marker, and sends SIGKILL (the `stop` effect) only when the grace ends.
 *
 * @module sub-agents/lib/supervisor.grace.test
 */

import { describe, expect, it } from "bun:test"

import { resultText } from "./content.ts"
import { parseStream, streamEnded, streamFailure, streamFinalText } from "./stream.ts"
import {
  DEFAULT_GRACE_SEC,
  type Effect,
  supervisorTick,
  type TickOutput,
  type WorkerProbe,
} from "./supervisor.ts"
import {
  type Progress,
  type ResultDigest,
  type SubagentRecord,
  type SubagentStatus,
  sessionId,
  subagentId,
} from "./types.ts"

const NOW_MS = Date.parse("2026-05-30T12:00:00.000Z")
const PROG: Progress = { tools: 4, tokens: 1200, lastTool: "Grep" }
const RESULT: ResultDigest = { short: "found 3 callers", tokens: 5000, tools: 12 }
const GRACE_MS = DEFAULT_GRACE_SEC * 1000
const TIMEOUT = "timed out (budget deadline exceeded)"

function rec(budget?: SubagentRecord["budget"]): SubagentRecord {
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
      startedAt: new Date(NOW_MS - 120_000).toISOString(), // 2 min ago
      progress: { tools: 0, tokens: 0 },
    },
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    ...(budget ? { budget } : {}),
  }
}

/** A worker with a 60 s deadline, started 2 min ago: past its deadline. */
const late = (): SubagentRecord => rec({ deadlineSec: 60 })

function tick(records: readonly SubagentRecord[], probe: WorkerProbe | undefined, nowMs: number) {
  const probes = new Map<string, WorkerProbe>(probe ? [["A1", probe]] : [])
  return supervisorTick({ records, probes, now: new Date(nowMs).toISOString(), nowMs })
}

const types = (out: TickOutput): string[] => out.effects.map((e: Effect) => e.type)
const status = (out: TickOutput): SubagentStatus | undefined => out.records[0]?.status

describe("supervisorTick — grace phase at the deadline", () => {
  it("sends SIGTERM once, keeps the worker running, and emits no terminal effects", () => {
    const out = tick([late()], { alive: true, progress: PROG }, NOW_MS)
    expect(out.changed).toBe(true)
    expect(out.effects).toEqual([
      { type: "signal", id: subagentId("A1"), pid: 4242, sig: "SIGTERM", reason: "deadline" },
    ])
    const st = status(out)
    expect(st?.kind).toBe("running")
    if (st?.kind === "running") {
      expect(st.grace).toEqual({
        until: new Date(NOW_MS + GRACE_MS).toISOString(),
        error: TIMEOUT,
      })
      expect(st.progress).toEqual(PROG)
    }
  })

  it("does not send SIGTERM again on the next ticks in the grace", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const second = tick(first.records, { alive: true, progress: PROG }, NOW_MS + 10_000)
    expect(second.effects).toEqual([])
    expect(status(second)?.kind).toBe("running")
    const third = tick(second.records, { alive: true }, NOW_MS + GRACE_MS - 1)
    expect(third.effects).toEqual([])
    expect(third.changed).toBe(false)
  })

  it("a sentinel in the grace finishes done (stop the pid, no timeout)", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: true, result: RESULT }, NOW_MS + 5_000)
    const st = status(out)
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") expect(st.result.short).toBe(RESULT.short)
    expect(types(out)).toContain("stop")
    expect(types(out)).not.toContain("signal")
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject?.type === "inject" && inject.text).not.toMatch(/timed out|failed/i)
  })

  it("a sentinel with an exit in the grace finishes done", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: false, result: RESULT }, NOW_MS + 5_000)
    expect(status(out)?.kind).toBe("done")
    expect(types(out)).not.toContain("stop")
  })

  // MAJ-3: the wrap-up turn ends with text only (outcome `truncated`, no
  // sentinel). The stream does not count `truncated` as a failure.
  const truncatedProbe = (extra: Partial<WorkerProbe> = {}): WorkerProbe => {
    const st = parseStream(
      `${[
        JSON.stringify({ type: "run_finished", outcome: "truncated" }),
        JSON.stringify({ type: "result", outcome: "truncated", text: "partial findings" }),
      ].join("\n")}\n`,
    )
    expect(streamEnded(st)).toBe(true)
    expect(streamFailure(st)).toBeUndefined()
    return {
      alive: true,
      runEnded: true,
      distilled: streamFinalText(st) ?? "",
      ...extra,
    }
  }

  it("a clean truncated run end, still alive, no sentinel: failed with the timeout text", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, truncatedProbe(), NOW_MS + 5_000)
    const st = status(out)
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") {
      expect(st.error).toBe(TIMEOUT)
      expect(st.salvage).toBe("partial findings")
      expect(st.exitCode).toBeUndefined()
    }
    expect(out.effects[0]).toMatchObject({ type: "stop", pid: 4242, reason: "grace: run ended" })
    expect(types(out)).toContain("inject")
  })

  it("the same truncated run end after the exit: the same failed result", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, truncatedProbe({ alive: false }), NOW_MS + 5_000)
    const st = status(out)
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") {
      expect(st.error).toBe(TIMEOUT)
      expect(st.salvage).toBe("partial findings")
      expect(st.exitCode).toBeUndefined()
    }
    expect(types(out)).not.toContain("stop")
  })

  it("a clean exit 0 in the grace with no sentinel also fails with the timeout text", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, truncatedProbe({ alive: false, exitCode: 0 }), NOW_MS + 5_000)
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toBe(TIMEOUT)
  })

  it("AgentResult text of a grace failure shows the salvaged final message", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, truncatedProbe(), NOW_MS + 5_000)
    const r = out.records[0]
    expect(r).toBeDefined()
    if (!r) return
    const text = resultText(r)
    expect(text).toContain(TIMEOUT)
    expect(text).toContain("--- salvaged findings ---\npartial findings")
  })

  it("an exit in the grace with no sentinel fails with the timeout text", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: false }, NOW_MS + 5_000)
    const st = status(out)
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") {
      expect(st.error).toBe(TIMEOUT)
      expect(st.exitCode).toBeUndefined()
    }
    expect(types(out)).not.toContain("stop")
    expect(types(out)).toContain("inject")
  })

  it("a crash exit in the grace keeps the crash text after the limit text", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: false, exitCode: 1, crash: "boom" }, NOW_MS + 5_000)
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toBe(`${TIMEOUT}; then boom`)
    expect(st?.kind === "failed" && st.exitCode).toBe(1)
  })

  it("an aborted run (failure line) in the grace fails with the timeout text", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: true, runEnded: true, runFailed: "aborted" }, NOW_MS)
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toBe(TIMEOUT)
    expect(out.effects[0]).toMatchObject({ type: "stop", pid: 4242 })
  })

  it("the grace end sends SIGKILL (stop) and fails with terminal effects", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, { alive: true }, NOW_MS + GRACE_MS)
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toBe(TIMEOUT)
    expect(out.effects[0]).toEqual({
      type: "stop",
      id: subagentId("A1"),
      pid: 4242,
      reason: "grace ended",
    })
    expect(types(out)).toEqual(["stop", "emit", "emit", "inject"])
  })

  it("the grace end also applies with no probe this tick", () => {
    const first = tick([late()], { alive: true }, NOW_MS)
    const out = tick(first.records, undefined, NOW_MS + GRACE_MS + 1)
    expect(status(out)?.kind).toBe("failed")
    expect(types(out)[0]).toBe("stop")
  })

  it("an unbudgeted worker keeps the default-deadline text through the grace", () => {
    const wedged: SubagentRecord = {
      ...rec(),
      status: {
        kind: "running",
        pid: 4242,
        startedAt: new Date(NOW_MS - 31 * 60_000).toISOString(),
        progress: { tools: 0, tokens: 0 },
      },
    }
    const first = tick([wedged], { alive: true }, NOW_MS)
    expect(types(first)).toEqual(["signal"])
    const out = tick(first.records, { alive: true }, NOW_MS + GRACE_MS)
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toMatch(/default hard deadline/)
  })

  it("a worker already gone at the deadline fails at once, with no SIGTERM", () => {
    const out = tick([late()], { alive: false }, NOW_MS)
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toBe(TIMEOUT)
    expect(types(out)).not.toContain("signal")
  })
})

describe("supervisorTick — grace phase at maxTurns / maxTokens", () => {
  const fresh = (budget: SubagentRecord["budget"]): SubagentRecord => {
    const r = rec(budget)
    return {
      ...r,
      status: {
        kind: "running",
        pid: 4242,
        startedAt: new Date(NOW_MS).toISOString(),
        progress: PROG,
      },
    }
  }

  it("maxTurns: SIGTERM first, the worker stays running", () => {
    const out = tick(
      [fresh({ maxTurns: 3 })],
      { alive: true, progress: { tools: 5, tokens: 10, turns: 4 } },
      NOW_MS,
    )
    expect(out.effects).toEqual([
      { type: "signal", id: subagentId("A1"), pid: 4242, sig: "SIGTERM", reason: "budget" },
    ])
    const st = status(out)
    expect(st?.kind === "running" && st.grace?.error).toBe(
      "budget exceeded: started turn 4 with maxTurns 3",
    )
  })

  it("maxTurns: the final turn in the grace does not send SIGTERM again", () => {
    const probe: WorkerProbe = { alive: true, progress: { tools: 1, tokens: 9, turns: 4 } }
    const first = tick([fresh({ maxTurns: 3 })], probe, NOW_MS)
    expect(types(first)).toEqual(["signal"])
    const more: WorkerProbe = { alive: true, progress: { tools: 2, tokens: 9, turns: 5 } }
    const second = tick(first.records, more, NOW_MS + 1_000)
    expect(second.effects).toEqual([])
    const st = status(second)
    expect(st?.kind === "running" && st.progress.turns).toBe(5)
  })

  // MAJ-1 (review 2): the wrap-up turn can spend much more than maxTokens, so
  // a maxTokens trip gets the old hard path: SIGKILL + failed at once.
  it("maxTokens: no grace, SIGKILL and failed at once with the budget text", () => {
    const probe: WorkerProbe = { alive: true, progress: { tools: 1, tokens: 9, output: 1200 } }
    const out = tick([fresh({ maxTokens: 1000 })], probe, NOW_MS)
    expect(types(out)).toEqual(["stop", "emit", "emit", "inject"])
    expect(types(out)).not.toContain("signal")
    expect(out.effects[0]).toEqual({
      type: "stop",
      id: subagentId("A1"),
      pid: 4242,
      reason: "budget",
    })
    const st = status(out)
    expect(st?.kind === "failed" && st.error).toBe(
      "budget exceeded: 1200 output tokens with maxTokens 1000",
    )
  })

  it("maxTokens wins over maxTurns when both trip: no grace", () => {
    const probe: WorkerProbe = {
      alive: true,
      progress: { tools: 1, tokens: 9, turns: 4, output: 1200 },
    }
    const out = tick([fresh({ maxTurns: 3, maxTokens: 1000 })], probe, NOW_MS)
    expect(types(out)).not.toContain("signal")
    expect(status(out)?.kind).toBe("failed")
  })

  it("maxTokens in the grace of another limit does not cut the grace", () => {
    const first = tick(
      [fresh({ maxTurns: 3, maxTokens: 1000 })],
      {
        alive: true,
        progress: { tools: 1, tokens: 9, turns: 4, output: 10 },
      },
      NOW_MS,
    )
    expect(types(first)).toEqual(["signal"])
    const more: WorkerProbe = {
      alive: true,
      progress: { tools: 1, tokens: 9, turns: 5, output: 5000 },
    }
    const second = tick(first.records, more, NOW_MS + 1_000)
    expect(second.effects).toEqual([])
    expect(status(second)?.kind).toBe("running")
  })

  it("maxTurns: a sentinel in the grace finishes done", () => {
    const probe: WorkerProbe = { alive: true, progress: { tools: 5, tokens: 10, turns: 4 } }
    const first = tick([fresh({ maxTurns: 3 })], probe, NOW_MS)
    const out = tick(first.records, { ...probe, result: RESULT }, NOW_MS + 1_000)
    expect(status(out)?.kind).toBe("done")
  })
})
