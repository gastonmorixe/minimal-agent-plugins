import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import setup from "../ui/setup.ts"

import { fmtElapsed, fmtTokens } from "./style.ts"
import { slots } from "./style-slots.ts"
import {
  type Progress,
  type ResultDigest,
  type SubagentRecord,
  type SubagentStatus,
  sessionId,
  subagentId,
} from "./types.ts"
import { blinkDot, blinkPhase, modelTag, renderWidget } from "./widget.ts"

// The display tests below check styled bytes: install the test kit (S41).
beforeAll(() => setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext))
afterAll(() => slots.reset())

const LEAD = "3f2a1111-2222-4333-8444-555566667777"
const NOW = Date.parse("2026-05-30T12:00:00.000Z")

function rec(id: string, label: string, status: SubagentStatus): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label,
    type: label,
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T11:58:00.000Z",
    status,
    depth: 1,
    leadSid: sessionId(LEAD),
  }
}
function running(progress: Progress, startedAt = "2026-05-30T11:58:38.000Z"): SubagentStatus {
  return { kind: "running", pid: 1, startedAt, progress }
}
const RESULT: ResultDigest = { short: "2 crit, 3 warn", tokens: 5200, tools: 18 }

describe("style formatters", () => {
  it("fmtTokens", () => {
    expect(fmtTokens(950)).toBe("950")
    expect(fmtTokens(9100)).toBe("9.1k")
    expect(fmtTokens(47_900)).toBe("47.9k")
    expect(fmtTokens(612_000)).toBe("612k")
  })
  it("fmtElapsed", () => {
    expect(fmtElapsed(500)).toBe("")
    expect(fmtElapsed(31_000)).toBe("0m31")
    expect(fmtElapsed(82_000)).toBe("1m22")
    expect(fmtElapsed(3_900_000)).toBe("1h05")
  })
})

const OPTS = { ansi: false, tick: 0, nowMs: NOW, leadSid: LEAD } as const

function lines(out: string | null): string[] {
  expect(out).not.toBeNull()
  return (out as string).split("\n")
}

describe("renderWidget", () => {
  it("collapses to null when no worker is active", () => {
    expect(renderWidget([], OPTS)).toBeNull()
    const allDone = [
      rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT }),
      rec("A2", "worker", { kind: "failed", endedAt: "t", error: "boom" }),
    ]
    expect(renderWidget(allDone, OPTS)).toBeNull()
  })

  it("renders a header with word counts and one row per active worker", () => {
    const records = [
      rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT }),
      rec(
        "A2",
        "worker",
        running({ tools: 14, tokens: 9100, lastActivity: "editing src/parser.ts" }),
      ),
      rec(
        "A3",
        "explorer",
        running({ tools: 6, tokens: 2000, lastActivity: "grep callers of fork()" }),
      ),
    ]
    const ls = lines(renderWidget(records, OPTS))
    expect(ls[0]).toContain("Fleet 3f2a")
    expect(ls[0]).toContain("2 running")
    expect(ls[0]).toContain("1 done")
    expect(ls[0]).not.toContain("failed") // zero counts are omitted
    expect(ls).toHaveLength(4) // header + 2 rows + summary
    expect(ls[1]).toMatch(/^├ [●○] A2 /)
    expect(ls[1]).toContain("editing src/parser.ts")
    expect(ls[1]).toContain("14 tools · 9.1k")
    expect(ls[2]).toMatch(/^├ [●○] A3 /)
    expect(ls[3]).toBe("╰ ✔ 1 done · SubAgentsListAgents")
  })

  it("collapses terminal workers into one summary row", () => {
    const records = [
      rec("A1", "w", running({ tools: 1, tokens: 1 })),
      rec("A2", "w", { kind: "done", endedAt: "t", result: RESULT }),
      rec("A3", "w", { kind: "done", endedAt: "t", result: RESULT }),
      rec("A4", "w", { kind: "failed", endedAt: "t", error: "boom" }),
      rec("A5", "w", {
        kind: "incomplete",
        endedAt: "t",
        reason: "no sentinel",
        tokens: 700,
        tools: 4,
      }),
    ]
    const ls = lines(renderWidget(records, OPTS))
    expect(ls).toHaveLength(3)
    expect(ls[0]).toContain("2 done · 1 incomplete · 1 failed")
    expect(ls[1]?.startsWith("├")).toBe(true)
    expect(ls[2]).toBe("╰ ✘ 1 failed · ⚠ 1 incomplete · ✔ 2 done · SubAgentsListAgents")
    for (const id of ["A2", "A3", "A4", "A5"]) expect(ls.join("\n")).not.toContain(id)
  })

  it("uses ╰ on the last agent row when nothing is summarized", () => {
    const records = [
      rec("A1", "w", running({ tools: 1, tokens: 1 })),
      rec("A2", "w", { kind: "queued" }),
    ]
    const ls = lines(renderWidget(records, OPTS))
    expect(ls).toHaveLength(3)
    expect(ls[1]?.startsWith("├")).toBe(true)
    expect(ls[2]).toMatch(/^╰ ◌ A2 /)
    expect(ls[2]).toContain("queued…")
    expect(ls[0]).toContain("1 queued")
  })

  it("shows 'stopping' on a running row in the grace after SIGTERM", () => {
    const base = running({ tools: 3, tokens: 900, lastActivity: "writing report" })
    if (base.kind !== "running") throw new Error("expected running status")
    const grace = { until: "2026-05-30T12:01:00.000Z", error: "timed out" }
    const out = renderWidget([rec("A1", "worker", { ...base, grace })], OPTS)
    expect(out).toContain("stopping")
  })

  it("puts active workers that do not fit as +N more on the summary row", () => {
    const records = [
      ...Array.from({ length: 9 }, (_, i) =>
        rec(`A${i + 1}`, "worker", running({ tools: 1, tokens: 100 })),
      ),
      rec("A10", "w", { kind: "done", endedAt: "t", result: RESULT }),
    ]
    const ls = lines(renderWidget(records, { ...OPTS, maxRows: 4 }))
    expect(ls).toHaveLength(1 + 4 + 1)
    expect(ls.at(-1)).toBe("╰ ✔ 1 done · +5 more · SubAgentsListAgents")
  })

  it("paints the token total over budget (GOLD) via ansi codes", () => {
    const records = [rec("A2", "worker", running({ tools: 1, tokens: 90_000 }))]
    const out = renderWidget(records, { ...OPTS, ansi: true, tokenBudget: 50_000 }) as string
    expect(out).toContain("\x1b[38;5;214m") // GOLD applied to the over-budget total
  })

  it("keeps every row inside the terminal width", () => {
    const long = "x".repeat(300)
    const records = [
      rec("A1", "worker", running({ tools: 103, tokens: 146_000, lastActivity: long })),
      rec("A2", "worker", { kind: "queued" }),
      rec("A3", "w", { kind: "failed", endedAt: "t", error: "boom" }),
    ]
    for (const columns of [40, 80, 120]) {
      for (const ansi of [false, true]) {
        const ls = lines(renderWidget(records, { ...OPTS, ansi, columns }))
        for (const l of ls) expect(displayWidth(l)).toBeLessThanOrEqual(columns - 1)
      }
    }
    const row = lines(renderWidget(records, { ...OPTS, columns: 80 }))[1] as string
    expect(row).toContain("…")
    expect(row).toContain("103 tools · 146k") // the right part stays
  })
})

describe("renderWidget — blink", () => {
  const records = [
    rec("A1", "w", running({ tools: 1, tokens: 1 })), // char sum 114, even → phase 0
    rec("A2", "w", running({ tools: 1, tokens: 1 })), // char sum 115, odd → phase 1
  ]
  const dots = (nowMs: number) =>
    lines(renderWidget(records, { ...OPTS, nowMs }))
      .slice(0, 3)
      .map((l) => (l.match(/[●○]/) ?? [""])[0])

  it("alternates the dot each second, with a phase per row", () => {
    expect(blinkPhase("A1")).toBe(0)
    expect(blinkPhase("A2")).toBe(1)
    const t0 = Math.floor(NOW / 2000) * 2000 // an even second
    const a = dots(t0)
    const b = dots(t0 + 1000)
    expect(a).toEqual(["●", "●", "○"]) // header (phase 0), A1, A2
    expect(b).toEqual(["○", "○", "●"])
    // Inside one second, the frame does not change.
    expect(dots(t0 + 999)).toEqual(a)
  })

  it("does not depend on tick", () => {
    const at = (tick: number) => renderWidget(records, { ...OPTS, tick })
    expect(at(0)).toBe(at(1))
  })

  it("fades the on dot in truecolor when fade is set", () => {
    const t0 = Math.floor(NOW / 2000) * 2000
    expect(blinkDot(0, t0, true, true)).not.toBe(blinkDot(0, t0 + 900, true, true))
    expect(blinkDot(0, t0 + 900, true, true)).toContain("\x1b[38;2;")
    expect(blinkDot(0, t0 + 900, true, false)).not.toContain("\x1b[38;2;")
  })
})

describe("renderWidget — stream telemetry", () => {
  const run = (progress: Progress): SubagentStatus => ({
    kind: "running",
    pid: 1,
    startedAt: "2026-05-30T11:59:00.000Z",
    progress,
  })

  it("shows the in-flight tool with how long it has run, and failed calls", () => {
    const out = renderWidget(
      [
        rec(
          "A1",
          "worker",
          run({
            tools: 5,
            tokens: 100,
            toolErrors: 2,
            phase: "tool",
            lastActivity: "Bash: bun test",
            toolSince: NOW - 42_000,
            lastEventAt: NOW - 42_000,
          }),
        ),
      ],
      OPTS,
    )
    expect(out).toContain("Bash: bun test (0m42)")
    expect(out).toContain("5 tools ✘2 · 100")
    // a long tool call is not "idle"
    expect(out).not.toContain("idle")
  })

  it("flags a silent stream as idle", () => {
    const out = renderWidget(
      [
        rec(
          "A1",
          "worker",
          run({
            tools: 1,
            tokens: 1,
            phase: "waiting",
            lastActivity: "Read: x",
            lastEventAt: NOW - 90_000,
          }),
        ),
      ],
      OPTS,
    )
    expect(out).toContain("idle 1m30")
  })

  it("shows thinking and writing phases", () => {
    const thinking = renderWidget(
      [rec("A1", "w", run({ tools: 0, tokens: 0, phase: "thinking" }))],
      OPTS,
    )
    expect(thinking).toContain("thinking…")
    const writing = renderWidget(
      [rec("A1", "w", run({ tools: 0, tokens: 0, phase: "writing", lastActivity: "The fix is" }))],
      OPTS,
    )
    expect(writing).toContain("✎ The fix is")
  })
})

describe("fleet row model tag", () => {
  it("shows the model tier, version and effort on each row", () => {
    const records = [
      {
        ...rec("A1", "explorer", running({ tools: 1, tokens: 10 })),
        model: "claude-opus-4-8",
        effort: "high",
      },
      { ...rec("A2", "worker", running({ tools: 1, tokens: 10 })), model: "claude-haiku-4-5" },
    ]
    const out = renderWidget(records, OPTS) as string
    expect(out).toContain("opus-4.8:high")
    expect(out).toContain("haiku-4.5")
    expect(out).not.toContain("haiku-4.5:")
  })

  it("prefers the resolved model and effort from progress over the record", () => {
    const records = [
      {
        ...rec(
          "A1",
          "w",
          running({ tools: 1, tokens: 10, model: "claude-sonnet-4-6", effort: "max" }),
        ),
        model: "claude-opus-4-8",
        effort: "low",
      },
      {
        ...rec("A2", "w", running({ tools: 1, tokens: 10, model: "claude-opus-5-5" })),
        model: "",
        effort: "high",
      },
    ]
    const ls = lines(renderWidget(records, OPTS))
    expect(ls[1]).toContain("sonnet-4.6:max")
    expect(ls[1]).not.toContain("opus")
    expect(ls[2]).toContain("opus-5.5:high") // effort falls back to the record
  })

  it("shows — when no model is known, and aligns the columns", () => {
    const records = [
      { ...rec("A1", "w", running({ tools: 1, tokens: 10 })), model: "" },
      { ...rec("A2", "w", running({ tools: 1, tokens: 10 })), model: "claude-opus-5-5" },
    ]
    const ls = lines(renderWidget(records, OPTS))
    expect(ls[1]).toContain(" — ")
    // The elapsed column starts at the same cell on both rows.
    const at = (l: string) => l.indexOf("1m22")
    expect(at(ls[1] as string)).toBeGreaterThan(0)
    expect(at(ls[1] as string)).toBe(at(ls[2] as string))
  })

  it("modelTag formats the version and handles missing parts", () => {
    expect(modelTag("claude-opus-5-5", undefined)).toBe("opus-5.5")
    expect(modelTag("claude-sonnet-4-6", "high")).toBe("sonnet-4.6:high")
    expect(modelTag("claude-haiku-4-5-20251001", undefined)).toBe("haiku-4.5")
    expect(modelTag("sonnet", "max")).toBe("sonnet:max")
    expect(modelTag(undefined, undefined)).toBe("")
    expect(modelTag(undefined, "max")).toBe("max")
    expect(modelTag("some-other", undefined)).toBe("some-other")
    expect(modelTag("gpt-5-codex-extra-long-name", undefined)).toBe("gpt-5-codex-ext…")
  })
})
