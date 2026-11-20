import { describe, expect, it } from "bun:test"

import {
  BUDGET_TEXT,
  budgetEnv,
  budgetLevel,
  createLatch,
  nextBudgetWarning,
  readBudgetEnv,
} from "./budget-warning.ts"
import { ENV_BUDGET, ENV_STARTED_AT, REPORT_RESULT_TOOL } from "./spawn.ts"
import { DEFAULT_DEADLINE_SEC, effectiveDeadlineSec } from "./supervisor.ts"

const START = Date.parse("2026-01-01T00:00:00.000Z")
const env = (budget: Parameters<typeof budgetEnv>[0]) =>
  budgetEnv(budget, new Date(START).toISOString())

describe("budgetEnv", () => {
  it("gives the effective deadline, the turn and token limits, and the start", () => {
    const e = env({ deadlineSec: 600, maxTurns: 20, maxTokens: 5000 })
    expect(JSON.parse(e[ENV_BUDGET] ?? "")).toEqual({
      deadlineSec: 600,
      maxTurns: 20,
      maxTokens: 5000,
    })
    expect(e[ENV_STARTED_AT]).toBe("2026-01-01T00:00:00.000Z")
  })

  it("an unbudgeted worker gets the 1800 s default deadline", () => {
    expect(JSON.parse(env(undefined)[ENV_BUDGET] ?? "")).toEqual({
      deadlineSec: DEFAULT_DEADLINE_SEC,
    })
    expect(DEFAULT_DEADLINE_SEC).toBe(1800)
    expect(JSON.parse(env({ deadlineSec: 0 })[ENV_BUDGET] ?? "")).toEqual({ deadlineSec: 1800 })
  })

  it("effectiveDeadlineSec is the supervisor value", () => {
    expect(effectiveDeadlineSec({ budget: { deadlineSec: 42 } })).toBe(42)
    expect(effectiveDeadlineSec({})).toBe(1800)
  })

  it("readBudgetEnv round-trips and rejects bad values", () => {
    expect(readBudgetEnv(env({ maxTurns: 10 }))).toEqual({
      budget: { deadlineSec: 1800, maxTurns: 10 },
      startedAtMs: START,
    })
    expect(readBudgetEnv({})).toBeNull()
    expect(readBudgetEnv({ [ENV_BUDGET]: "", [ENV_STARTED_AT]: "" })).toBeNull()
    expect(readBudgetEnv({ [ENV_BUDGET]: "{bad", [ENV_STARTED_AT]: "2026-01-01" })).toBeNull()
    expect(
      readBudgetEnv({ [ENV_BUDGET]: '{"deadlineSec":0}', [ENV_STARTED_AT]: "2026-01-01" }),
    ).toBeNull()
  })
})

describe("budgetLevel", () => {
  const t = (elapsedMs: number, turnsUsed = 0, maxTurns?: number) =>
    budgetLevel({
      elapsedMs,
      deadlineMs: 1000,
      turnsUsed,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    })

  it("time thresholds: warn at 75 %, final at 90 %", () => {
    expect(t(749)).toBeNull()
    expect(t(750)).toBe("warn")
    expect(t(899)).toBe("warn")
    expect(t(900)).toBe("final")
    expect(t(5000)).toBe("final")
  })

  it("turn thresholds: warn at max(3, ceil 10 %) left, final at 1 left", () => {
    // maxTurns 10: warn threshold max(3, 1) = 3.
    expect(t(0, 6, 10)).toBeNull()
    expect(t(0, 7, 10)).toBe("warn")
    expect(t(0, 8, 10)).toBe("warn")
    expect(t(0, 9, 10)).toBe("final")
    expect(t(0, 12, 10)).toBe("final")
    // maxTurns 50: warn threshold ceil(5) = 5.
    expect(t(0, 44, 50)).toBeNull()
    expect(t(0, 45, 50)).toBe("warn")
    // maxTurns 41: ceil(4.1) = 5.
    expect(t(0, 36, 41)).toBe("warn")
    expect(t(0, 35, 41)).toBeNull()
  })

  it("small maxTurns (MIN-4): warn at min(max(3, ceil 10 %), floor(max / 2)) left", () => {
    // maxTurns 1: warnTurns 0, no turn-based final. Warn only when no turn stays.
    expect(t(0, 0, 1)).toBeNull()
    expect(t(0, 1, 1)).toBe("warn")
    expect(t(0, 2, 1)).toBe("warn")
    // maxTurns 2: warnTurns 1, no turn-based final.
    expect(t(0, 0, 2)).toBeNull()
    expect(t(0, 1, 2)).toBe("warn")
    expect(t(0, 2, 2)).toBe("warn")
    // maxTurns 4: warnTurns 2. Turn 1 gives no tag.
    expect(t(0, 1, 4)).toBeNull()
    expect(t(0, 2, 4)).toBe("warn")
    expect(t(0, 3, 4)).toBe("final")
    // maxTurns 10: warnTurns 3 (no change).
    expect(t(0, 6, 10)).toBeNull()
    expect(t(0, 7, 10)).toBe("warn")
    expect(t(0, 9, 10)).toBe("final")
    // maxTurns 80: warnTurns 8.
    expect(t(0, 71, 80)).toBeNull()
    expect(t(0, 72, 80)).toBe("warn")
    expect(t(0, 78, 80)).toBe("warn")
    expect(t(0, 79, 80)).toBe("final")
  })

  it("small maxTurns: the time thresholds still give final", () => {
    expect(t(900, 0, 1)).toBe("final")
    expect(t(900, 0, 2)).toBe("final")
  })

  it("no maxTurns: only the time counts", () => {
    expect(t(0, 999)).toBeNull()
  })
})

describe("nextBudgetWarning", () => {
  const e = env({ deadlineSec: 100, maxTurns: 20 })

  it("no budget env gives null", () => {
    expect(nextBudgetWarning({}, START + 99_000, 19, createLatch())).toBeNull()
  })

  it("each level fires once, in order", () => {
    const latch = createLatch()
    expect(nextBudgetWarning(e, START + 10_000, 1, latch)).toBeNull()
    expect(nextBudgetWarning(e, START + 75_000, 2, latch)).toEqual({
      level: "warn",
      elapsed: 75,
      remaining: 25,
      turnsLeft: 18,
    })
    expect(nextBudgetWarning(e, START + 80_000, 3, latch)).toBeNull()
    expect(nextBudgetWarning(e, START + 90_500, 4, latch)).toEqual({
      level: "final",
      elapsed: 90,
      remaining: 10,
      turnsLeft: 16,
    })
    expect(nextBudgetWarning(e, START + 95_000, 5, latch)).toBeNull()
    expect(nextBudgetWarning(e, START + 200_000, 30, latch)).toBeNull()
  })

  it("a jump to final skips warn, and warn never comes after final", () => {
    const latch = createLatch()
    expect(nextBudgetWarning(e, START, 19, latch)?.level).toBe("final")
    expect(nextBudgetWarning(e, START + 76_000, 19, latch)).toBeNull()
  })

  it("past the deadline: remaining is 0", () => {
    expect(nextBudgetWarning(e, START + 150_000, 0, createLatch())?.remaining).toBe(0)
  })

  it("the texts are short and name the real tool", () => {
    expect(REPORT_RESULT_TOOL).toBe("SubAgentsReportResult")
    expect(BUDGET_TEXT.warn).toContain(REPORT_RESULT_TOOL)
    expect(BUDGET_TEXT.final).toContain(REPORT_RESULT_TOOL)
    expect(BUDGET_TEXT.warn).toBe(
      "You used most of your time or turns. Complete your work quickly. Then use SubAgentsReportResult.",
    )
  })
})
