import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import type { ToolResultStage } from "@minimal-agent/core/plugin-api/types/tool-result-chain"

import { budgetEnv, createLatch } from "../lib/budget-warning.ts"
import { ENV_RESULT_PATH } from "../lib/spawn.ts"
import { ENV_SID } from "../lib/spawn-plan.ts"

import budgetTransforms, { createBudgetStage, ownStreamPath } from "./budget_transforms.ts"

const START = Date.parse("2026-01-01T00:00:00.000Z")
const WORKER = {
  ...budgetEnv({ deadlineSec: 100, maxTurns: 20 }, new Date(START).toISOString()),
  [ENV_RESULT_PATH]: "/tmp/sessions/sid-1.result.json",
}

const stage = (): ToolResultStage =>
  ({
    tool: "Bash",
    toolUseId: "t1",
    input: {},
    body: { text: "ok" },
    annotations: [],
  }) as unknown as ToolResultStage

function make(env: Record<string, string>, clock: { now: number }, turns = 0) {
  return createBudgetStage({
    env: () => env,
    now: () => clock.now,
    turnsUsed: () => turns,
    latch: createLatch(),
  })
}

const run = (d: ReturnType<typeof make>) =>
  d.transform(stage(), { signal: new AbortController().signal }) as ToolResultStage

describe("budget stamp stage", () => {
  it("is a stamp stage", () => {
    expect(make(WORKER, { now: START }).phase).toBe("stamp")
  })

  it("adds one annotation at warn, one at final, none otherwise", () => {
    const clock = { now: START + 10_000 }
    const d = make(WORKER, clock)
    expect(run(d).annotations).toEqual([])
    clock.now = START + 76_000
    expect(run(d).annotations).toEqual([
      {
        kind: "budget",
        attrs: { elapsed: 76, remaining: 24, "turns-left": 20, level: "warn" },
        body: "You used most of your time or turns. Complete your work quickly. Then use SubAgentsReportResult.",
        text: "",
        join: "\n\n",
        owner: "sub-agents",
      },
    ])
    expect(run(d).annotations).toEqual([])
    clock.now = START + 91_000
    const fin = run(d).annotations
    expect(fin).toHaveLength(1)
    expect(fin[0]?.attrs?.level).toBe("final")
    expect(run(d).annotations).toEqual([])
  })

  it("keeps the other annotations and does not change the input", () => {
    const d = make(WORKER, { now: START + 95_000 })
    const input = stage()
    const prior = { kind: "mode-active", text: "<m />", join: "\n\n", owner: "core" }
    const out = d.transform({ ...input, annotations: [prior] } as ToolResultStage, {
      signal: new AbortController().signal,
    }) as ToolResultStage
    expect(out.annotations[0]).toEqual(prior)
    expect(out.annotations[1]?.kind).toBe("budget")
    expect(input.annotations).toEqual([])
  })

  it("no ENV_RESULT_PATH: a no-op, also with the budget env", () => {
    const { [ENV_RESULT_PATH]: _, ...lead } = WORKER
    const s = stage()
    const d = make(lead, { now: START + 99_000 }, 19)
    expect(d.transform(s, { signal: new AbortController().signal })).toBe(s)
  })

  it("the factory gives no stage in a lead, one stage in a worker", () => {
    expect(budgetTransforms({})).toEqual([])
    expect(budgetTransforms({ [ENV_RESULT_PATH]: "  " })).toEqual([])
    const decls = budgetTransforms(WORKER)
    expect(decls).toHaveLength(1)
    expect(decls[0]?.phase).toBe("stamp")
  })
})

describe("turn count from the own stream", () => {
  let dir = ""
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("the stream path is next to the sentinel, named by the sid", () => {
    expect(ownStreamPath({ [ENV_RESULT_PATH]: "/s/abc.result.json", [ENV_SID]: "abc" })).toBe(
      "/s/abc.stream.ndjson",
    )
    expect(ownStreamPath({ [ENV_RESULT_PATH]: "/s/xyz.result.json" })).toBe("/s/xyz.stream.ndjson")
    expect(ownStreamPath({})).toBeUndefined()
  })

  it("the production stage reads turn_started like the supervisor", () => {
    dir = mkdtempSync(join(tmpdir(), "budget-stream-"))
    const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((turn, seq) =>
      JSON.stringify({ type: "turn_started", turn, seq, ts: START }),
    )
    writeFileSync(join(dir, "sid-9.stream.ndjson"), `${lines.join("\n")}\n`)
    const env = {
      // maxTurns 10, turn 9 started: 1 turn left, so final at time 0.
      ...budgetEnv({ maxTurns: 10 }, new Date().toISOString()),
      [ENV_RESULT_PATH]: join(dir, "sid-9.result.json"),
      [ENV_SID]: "sid-9",
    }
    const prev = { ...process.env }
    Object.assign(process.env, env)
    try {
      const [d] = budgetTransforms(env)
      const out = d?.transform(stage(), {
        signal: new AbortController().signal,
      }) as ToolResultStage
      expect(out.annotations[0]?.attrs).toMatchObject({ "turns-left": 1, level: "final" })
    } finally {
      for (const k of Object.keys(env)) if (!(k in prev)) delete process.env[k]
      Object.assign(process.env, prev)
    }
  })
})
