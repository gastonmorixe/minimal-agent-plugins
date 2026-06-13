import { describe, expect, test } from "bun:test"

import type { SpeechJob } from "./registry.ts"
import {
  configureSgr,
  formatDuration,
  jobElapsedMs,
  renderFooter,
  renderJobLine,
  renderJobList,
  resolveSgr,
  stateGlyph,
  stateWord,
} from "./render.ts"

/** Strip ANSI so assertions read on the plain text. */
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function job(over: Partial<SpeechJob> = {}): SpeechJob {
  return {
    id: "s1",
    pid: 4242,
    backend: "macos-say",
    charCount: 11,
    preview: "hello there",
    state: "speaking",
    startedAt: 1000,
    ...over,
  }
}

describe("style facade", () => {
  test("uses standalone ANSI fallbacks", () => {
    expect(plain(stateGlyph("failed"))).toBe("✘ failed")
    expect(resolveSgr("not json").red).toBe("\x1b[31m")
  })

  test("resolves foreground tokens from host-injected palette context", () => {
    const sgr = resolveSgr(
      JSON.stringify({
        red: "\x1b[38;5;196m",
        green: "\x1b[38;5;118m",
        yellow: "\x1b[38;5;214m",
        cyan: "\x1b[38;5;45m",
        _fgReset: "\x1b[39m",
      }),
    )
    expect(sgr.red).toBe("\x1b[38;5;196m")
    expect(sgr.green).toBe("\x1b[38;5;118m")
    expect(sgr.yellow).toBe("\x1b[38;5;214m")
    expect(sgr.cyan).toBe("\x1b[38;5;45m")
    expect(sgr.fgReset).toBe("\x1b[39m")
  })

  test("configured facade uses host context for rendered glyphs", () => {
    configureSgr(JSON.stringify({ red: "\x1b[38;5;196m", _fgReset: "\x1b[39m" }))
    expect(stateGlyph("failed")).toBe("\x1b[38;5;196m✘ failed\x1b[39m")
    configureSgr(undefined)
  })
})

describe("stateGlyph / stateWord", () => {
  test("glyph carries the state word", () => {
    expect(plain(stateGlyph("speaking"))).toContain("speaking")
    expect(plain(stateGlyph("done"))).toContain("done")
    expect(plain(stateGlyph("failed"))).toContain("failed")
    expect(plain(stateGlyph("stopped"))).toContain("stopped")
  })

  test("stateWord is the bare state", () => {
    expect(stateWord("speaking")).toBe("speaking")
    expect(stateWord("done")).toBe("done")
  })
})

describe("formatDuration", () => {
  test("sub-10s shows one decimal", () => {
    expect(formatDuration(400)).toBe("0.4s")
    expect(formatDuration(9400)).toBe("9.4s")
  })

  test("10-59s shows whole seconds", () => {
    expect(formatDuration(12_000)).toBe("12s")
  })

  test("minute+ shows m+ss", () => {
    expect(formatDuration(63_000)).toBe("1m03s")
    expect(formatDuration(125_000)).toBe("2m05s")
  })

  test("clamps negative to zero", () => {
    expect(formatDuration(-50)).toBe("0.0s")
  })
})

describe("jobElapsedMs", () => {
  test("uses endedAt when terminal", () => {
    expect(jobElapsedMs(job({ startedAt: 1000, endedAt: 3500 }), 9999)).toBe(2500)
  })

  test("uses now when still speaking", () => {
    expect(jobElapsedMs(job({ startedAt: 1000 }), 4000)).toBe(3000)
  })
})

describe("renderJobLine", () => {
  test("includes id, state, pid, and preview", () => {
    const line = plain(renderJobLine(job(), 2000))
    expect(line).toContain("s1")
    expect(line).toContain("speaking")
    expect(line).toContain("pid 4242")
    expect(line).toContain("hello there")
  })

  test("shows ? when pid is 0", () => {
    expect(plain(renderJobLine(job({ pid: 0 }), 2000))).toContain("pid ?")
  })
})

describe("renderJobList", () => {
  test("empty list → placeholder", () => {
    expect(plain(renderJobList([], 0))).toContain("no speech jobs")
  })

  test("one line per job", () => {
    const out = plain(renderJobList([job({ id: "s1" }), job({ id: "s2" })], 2000))
    expect(out.split("\n").length).toBe(2)
    expect(out).toContain("s1")
    expect(out).toContain("s2")
  })
})

describe("renderFooter", () => {
  test("shows backend and char count", () => {
    const f = plain(renderFooter(job({ backend: "macos-say", charCount: 123 })))
    expect(f).toContain("macos-say")
    expect(f).toContain("123 chars")
  })
})
