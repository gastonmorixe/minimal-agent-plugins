import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import setup from "../ui/setup.ts"

import {
  clip,
  elapsed,
  jobBlock,
  jobHeaderContent,
  jobLine,
  jobLines,
  renderWidget,
  statusGlyph,
  statusWord,
  tildify,
} from "./render.ts"
import { slots } from "./style.ts"
import { type JobRecord, type JobStatus, jobId, pid } from "./types.ts"

// The display tests below check styled bytes: install the test kit (S41).
beforeAll(() => setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext))
afterAll(() => slots.reset())

function strip(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertions
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function rec(id: string, status: JobStatus, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: jobId(id),
    command: "bun test",
    cwd: "/tmp",
    runnerPid: pid(100),
    timeoutMs: 600_000,
    spawnedAt: "2026-06-04T00:00:00.000Z",
    status,
    logPath: `/tmp/${id}.log`,
    statusPath: `/tmp/${id}.status.json`,
    ...over,
  }
}

const running: JobStatus = { kind: "running", pid: pid(1), startedAt: "2026-06-04T00:00:00.000Z" }

describe("style slots (S41)", () => {
  test("ui/setup.ts installs the terminal kit; reset makes styles plain", () => {
    slots.reset()
    expect(slots.installed()).toBe(false)
    expect(slots.palette.red).toBe("")
    setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext)
    expect(slots.palette.red).toBe("\x1b[31m")
  })
})

describe("clip", () => {
  test("short passes through", () => {
    expect(clip("hi", 10)).toBe("hi")
  })
  test("long ellipsizes", () => {
    expect(clip("abcdefghij", 5)).toBe("abcd…")
  })
  test("collapses whitespace", () => {
    expect(clip("a\n  b   c", 100)).toBe("a b c")
  })
})

describe("statusGlyph / statusWord", () => {
  test("each kind renders", () => {
    const kinds: JobStatus[] = [
      running,
      { kind: "exited", endedAt: "t", exitCode: 0 },
      { kind: "exited", endedAt: "t", exitCode: 2 },
      { kind: "timedout", endedAt: "t", timeoutMs: 1000 },
      { kind: "stopped", endedAt: "t" },
      { kind: "orphaned", endedAt: "t", reason: "x" },
    ]
    for (const k of kinds) {
      expect(strip(statusGlyph(k)).length).toBeGreaterThan(0)
      expect(statusWord(k).length).toBeGreaterThan(0)
    }
  })
  test("exit 0 reads done, non-zero reads failed", () => {
    expect(statusWord({ kind: "exited", endedAt: "t", exitCode: 0 })).toBe("done")
    expect(statusWord({ kind: "exited", endedAt: "t", exitCode: 1 })).toContain("failed")
  })
})

describe("elapsed", () => {
  test("running uses now", () => {
    const nowMs = Date.parse("2026-06-04T00:00:41.000Z")
    expect(elapsed(rec("j1", running), nowMs)).toBe("41s")
  })
  test("terminal uses endedAt", () => {
    const r = rec("j1", { kind: "exited", endedAt: "2026-06-04T00:10:00.000Z", exitCode: 0 })
    expect(elapsed(r, Date.parse("2026-06-04T05:00:00.000Z"))).toBe("10m")
  })
  test("a just-started job reads 0s, never ∞", () => {
    const now = Date.parse("2026-06-04T00:00:00.000Z")
    expect(elapsed(rec("j1", running), now)).toBe("0s")
  })
})

describe("jobLine / jobLines", () => {
  test("line contains id and status", () => {
    const line = strip(jobLine(rec("j1", running), Date.parse("2026-06-04T00:00:05.000Z")))
    expect(line).toContain("j1")
    expect(line).toContain("running")
  })
  test("empty list note", () => {
    expect(strip(jobLines([], 0))).toContain("no background jobs")
  })
  test("uses description over command", () => {
    const line = strip(jobLine(rec("j1", running, { description: "the build" }), 0))
    expect(line).toContain("the build")
  })
})

describe("tildify", () => {
  test("collapses a leading home dir to ~", () => {
    expect(tildify("/home/me/p/x", "/home/me")).toBe("~/p/x")
    expect(tildify("/home/me", "/home/me")).toBe("~")
  })
  test("leaves non-home paths alone", () => {
    expect(tildify("/var/log/x", "/home/me")).toBe("/var/log/x")
  })
})

describe("jobHeaderContent", () => {
  test("shows id, state, elapsed, pid for a running job", () => {
    const now = Date.parse("2026-06-04T00:00:05.000Z")
    const h = strip(jobHeaderContent(rec("j13", running, { jobPid: pid(4823) }), now))
    expect(h).toContain("j13")
    expect(h).toContain("running")
    expect(h).toContain("5s")
    expect(h).toContain("pid 4823")
  })
  test("no pid for a finished job", () => {
    const r = rec("j1", { kind: "exited", endedAt: "2026-06-04T00:00:10.000Z", exitCode: 0 })
    const h = strip(jobHeaderContent(r, Date.parse("2026-06-04T00:01:00.000Z")))
    expect(h).toContain("done")
    expect(h).not.toContain("pid")
  })
})

describe("jobBlock", () => {
  test("surfaces command, cwd, log path and follow-up calls", () => {
    const now = Date.parse("2026-06-04T00:00:05.000Z")
    const r = rec("j13", running, {
      command: "bun run build && ./install.sh",
      cwd: "/work/app",
      logPath: "/sessions/x.bgjobs/j13.log",
    })
    const b = strip(jobBlock(r, now))
    expect(b).toContain("bun run build && ./install.sh")
    expect(b).toContain("/work/app")
    expect(b).toContain("/sessions/x.bgjobs/j13.log")
    expect(b).toContain("BackgroundLogs j13")
    expect(b).toContain("BackgroundStop j13")
    expect(b).toContain("running")
  })
  test("finished job omits the stop hint, keeps logs hint", () => {
    const r = rec("j1", { kind: "exited", endedAt: "t", exitCode: 0 })
    const b = strip(jobBlock(r, 0))
    expect(b).toContain("BackgroundLogs j1")
    expect(b).not.toContain("BackgroundStop")
  })
  test("marks a multi-line command", () => {
    const r = rec("j1", running, { command: "for x in 1 2 3; do\n  echo $x\ndone" })
    const b = strip(jobBlock(r, 0))
    expect(b).toContain("for x in 1 2 3; do")
    expect(b).toContain("↵")
  })
})

describe("renderWidget", () => {
  test("null when nothing running", () => {
    expect(
      renderWidget([rec("j1", { kind: "exited", endedAt: "t", exitCode: 0 })], {
        tick: 0,
        nowMs: 0,
      }),
    ).toBeNull()
  })
  test("header counts running, rows name each job", () => {
    const now = Date.parse("2026-06-04T00:00:05.000Z")
    const w = strip(
      renderWidget([rec("j1", running), rec("j2", running)], { tick: 0, nowMs: now }) ?? "",
    )
    expect(w).toContain("Jobs")
    expect(w).toContain("2 running")
    expect(w).toContain("j1")
    expect(w).toContain("j2")
  })
  test("each running job is its own row with its label", () => {
    const now = Date.parse("2026-06-04T00:00:05.000Z")
    const w =
      renderWidget([rec("j1", running, { description: "build the app" }), rec("j2", running)], {
        tick: 0,
        nowMs: now,
      }) ?? ""
    // header + 2 rows = 3 lines
    expect(w.split("\n").length).toBe(3)
    expect(strip(w)).toContain("build the app")
  })
  test("collapses past maxRows", () => {
    const now = Date.parse("2026-06-04T00:00:05.000Z")
    const records = ["j1", "j2", "j3", "j4", "j5"].map((id) => rec(id, running))
    const w = strip(renderWidget(records, { tick: 1, nowMs: now, maxRows: 2 }) ?? "")
    expect(w).toContain("+3 more")
  })
  test("header notes finished + failed counts alongside running", () => {
    const now = Date.parse("2026-06-04T00:00:05.000Z")
    const records = [
      rec("j1", running),
      rec("j2", { kind: "exited", endedAt: "t", exitCode: 0 }),
      rec("j3", { kind: "exited", endedAt: "t", exitCode: 2 }),
    ]
    const w = strip(renderWidget(records, { tick: 0, nowMs: now }) ?? "")
    expect(w).toContain("1 done")
    expect(w).toContain("1 failed")
  })
})

describe("renderWidget header (fleet layout)", () => {
  const now = Date.parse("2026-06-04T00:00:05.000Z")
  const firstLine = (w: string | null): string => strip(w ?? "").split("\n")[0] ?? ""

  test("header is a blink dot, the word Jobs, and the counts", () => {
    const w = renderWidget([rec("j1", running), rec("j2", running)], { tick: 0, nowMs: now })
    expect(firstLine(w)).toMatch(/^[●○] Jobs · 2 running$/)
  })
  test("header dot blinks by nowMs: an even second is on, an odd second is off", () => {
    const records = [rec("j1", running)]
    const even = renderWidget(records, { tick: 0, nowMs: 4000 })
    const odd = renderWidget(records, { tick: 0, nowMs: 5000 })
    expect(firstLine(even).startsWith("● ")).toBe(true)
    expect(firstLine(odd).startsWith("○ ")).toBe(true)
  })
  test("header counts have no glyph of their own", () => {
    const records = [
      rec("j1", running),
      rec("j2", { kind: "exited", endedAt: "t", exitCode: 0 }),
      rec("j3", { kind: "exited", endedAt: "t", exitCode: 2 }),
    ]
    expect(firstLine(renderWidget(records, { tick: 0, nowMs: now }))).toMatch(
      /^[●○] Jobs · 1 running · 1 done · 1 failed$/,
    )
  })
  test("header is at most cols - 1 cells wide", () => {
    const records = [
      rec("j1", running),
      rec("j2", { kind: "exited", endedAt: "t", exitCode: 0 }),
      rec("j3", { kind: "exited", endedAt: "t", exitCode: 2 }),
      rec("j4", { kind: "stopped", endedAt: "t" }),
    ]
    const w = renderWidget(records, { tick: 0, nowMs: now, cols: 30 })
    expect(displayWidth(firstLine(w))).toBeLessThanOrEqual(29)
  })
})

describe("renderWidget rows (fleet layout)", () => {
  const now = Date.parse("2026-06-04T00:00:05.000Z")
  const lines = (w: string | null): string[] => strip(w ?? "").split("\n")

  test("2 running jobs give a tree: the first row has ├, the last row has ╰", () => {
    const rows = lines(
      renderWidget([rec("j1", running), rec("j2", running)], { tick: 0, nowMs: now }),
    )
    expect(rows.length).toBe(3)
    expect(rows[1]?.startsWith("├ ")).toBe(true)
    expect(rows[2]?.startsWith("╰ ")).toBe(true)
  })
  test("a running row has a blink dot, the padded id, the elapsed time, and the label", () => {
    const rows = lines(
      renderWidget([rec("j1", running, { description: "build the app" })], { tick: 0, nowMs: now }),
    )
    expect(rows[1]).toMatch(/^╰ [●○] j1 {2,}5s build the app$/)
  })
  test("no row is wider than cols - 1 for a long command", () => {
    const long = `bun run ${"x".repeat(200)}`
    const w = renderWidget([rec("j1", running, { command: long }), rec("j2", running)], {
      tick: 0,
      nowMs: now,
      cols: 40,
    })
    for (const row of lines(w)) expect(displayWidth(row)).toBeLessThanOrEqual(39)
  })
  test("no row is wider than cols - 1 on a narrow terminal", () => {
    const w = renderWidget([rec("j1", running, { description: "build the app now" })], {
      tick: 0,
      nowMs: now,
      cols: 24,
    })
    for (const row of lines(w)) expect(displayWidth(row)).toBeLessThanOrEqual(23)
  })
})

describe("renderWidget summary row", () => {
  const now = Date.parse("2026-06-04T00:00:05.000Z")
  const lines = (w: string | null): string[] => strip(w ?? "").split("\n")

  test("terminal jobs keep their rows, and a ╰ summary row closes the tree", () => {
    const records = [
      rec("j1", running),
      rec("j2", { kind: "exited", endedAt: "t", exitCode: 0 }),
      rec("j3", { kind: "exited", endedAt: "t", exitCode: 2 }),
    ]
    const rows = lines(renderWidget(records, { tick: 0, nowMs: now }))
    // header, 3 job rows (terminal rows stay visible), 1 summary row
    expect(rows.length).toBe(5)
    expect(rows.slice(1, 4).every((r) => r.startsWith("├ "))).toBe(true)
    expect(rows[4]).toBe("╰ ✘ 1 failed · ✔ 1 done · BackgroundStatus")
  })
  test("past maxRows, the summary row has +N more", () => {
    const records = ["j1", "j2", "j3", "j4", "j5"].map((id) => rec(id, running))
    const rows = lines(renderWidget(records, { tick: 0, nowMs: now, maxRows: 2 }))
    expect(rows.length).toBe(4)
    expect(rows[3]).toBe("╰ +3 more · BackgroundStatus")
  })
  test("a stopped job shows in the summary row", () => {
    const records = [rec("j1", running), rec("j2", { kind: "stopped", endedAt: "t" })]
    const rows = lines(renderWidget(records, { tick: 0, nowMs: now }))
    expect(rows.at(-1)).toBe("╰ ■ 1 stopped · BackgroundStatus")
  })
})
