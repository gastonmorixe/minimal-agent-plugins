import { describe, expect, test } from "bun:test"

import {
  clip,
  configureSgr,
  elapsed,
  jobBlock,
  jobHeaderContent,
  jobLine,
  jobLines,
  renderWidget,
  resolveSgr,
  statusGlyph,
  statusWord,
  tildify,
} from "./render.ts"
import { type JobRecord, type JobStatus, jobId, pid } from "./types.ts"

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

describe("style facade", () => {
  test("uses standalone ANSI fallbacks", () => {
    expect(resolveSgr("not json").red).toBe("\x1b[31m")
    expect(resolveSgr("not json").gray).toBe("\x1b[90m")
  })

  test("resolves foreground tokens from host-injected palette context", () => {
    const sgr = resolveSgr(
      JSON.stringify({
        red: "\x1b[38;5;196m",
        green: "\x1b[38;5;118m",
        yellow: "\x1b[38;5;214m",
        cyan: "\x1b[38;5;45m",
        gray: "\x1b[38;5;246m",
        _fgReset: "\x1b[39m",
      }),
    )
    expect(sgr.red).toBe("\x1b[38;5;196m")
    expect(sgr.green).toBe("\x1b[38;5;118m")
    expect(sgr.yellow).toBe("\x1b[38;5;214m")
    expect(sgr.cyan).toBe("\x1b[38;5;45m")
    expect(sgr.gray).toBe("\x1b[38;5;246m")
    expect(sgr.fgReset).toBe("\x1b[39m")
  })

  test("configured facade uses host context for rendered glyphs", () => {
    configureSgr(JSON.stringify({ red: "\x1b[38;5;196m", _fgReset: "\x1b[39m" }))
    expect(statusGlyph({ kind: "exited", endedAt: "t", exitCode: 1 })).toContain("\x1b[38;5;196m")
    configureSgr(undefined)
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
    expect(w).toContain("jobs")
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
