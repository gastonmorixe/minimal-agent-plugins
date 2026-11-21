import { describe, expect, test } from "bun:test"

import createCodec from "./codec.ts"
import { makeRegistry } from "./testing.ts"

const codec = createCodec(makeRegistry())
const strip = codec.stripLenient as NonNullable<typeof codec.stripLenient>
const leading = codec.leadingNode as NonNullable<typeof codec.leadingNode>

// The old regexes of the readers (core HEAD session-summary.ts and
// session-title.ts, title plugin input.ts). The lenient strip must give the
// same text for each `ma::` case below.
const MA_BLOCK_RE = /<(ma::[\w:.-]+)(?:\s[^>]*[^/>])?\s*>((?:(?!<\1[\s/>])[\s\S])*?)<\/\1\s*>/g
const MA_SELF_CLOSING_RE = /<ma::[\w:.-]+(?:\s[^>]*?)?\/>/g
const MA_UNCLOSED_LINE_RE = /<ma::[\w:.-]+(?:\s[^>]*[^/>])?\s*>[^\n]*\n/g
const MA_LONE_TAG_RE = /<\/?ma::[\w:.-]+(?:\s[^>]*)?>/g
const MA_TAG = /<\/?ma::[^>]*>?/g
const MA_PAIRED_TAG_RE = /<ma::([\w.:-]+)\b[^>]*>[\s\S]*?<\/ma::\1\s*>/g
const MA_SINGLE_TAG_RE = /<\/?ma::[^>]*>/g

/** Old core `stripInjectedContext`, without the system blocks. */
function oldSummary(text: string): string {
  let out = text.replace(MA_SELF_CLOSING_RE, " ")
  for (let i = 0; i < 8; i++) {
    const next = out.replace(MA_BLOCK_RE, " ")
    if (next === out) break
    out = next
  }
  return out.replace(MA_UNCLOSED_LINE_RE, "\n").replace(MA_LONE_TAG_RE, " ")
}
/** Old core `sanitizeTitle` tag step. */
const oldTitle = (text: string): string => text.replace(MA_TAG, " ")
/** Title plugin `stripMaTags`. */
const oldPlugin = (text: string): string =>
  text.replace(MA_PAIRED_TAG_RE, "").replace(MA_SINGLE_TAG_RE, "")

const SUMMARY = { replacement: " " }
const TITLE = { replacement: " ", keepBody: true }

const CASES = [
  '<ma::agent::mode-change from="default" to="ask" at="x" /> fix the parser <ma::agent::policy>Current local time: 2026</ma::agent::policy>',
  '<ma::agent::mode-change from="a" to="b" />',
  "<ma::agent::policy>x</ma::agent::policy>",
  "<ma::agent::session-resumed>resumed</ma::agent::session-resumed>",
  "<ma::agent::tasks>a",
  '<ma::agent::mode-change from="a" />REAL<ma::agent::mode-change>x</ma::agent::mode-change>',
  "<ma::a::b>LEAK<ma::a::b>in</ma::a::b> LEAK</ma::a::b> REAL",
  "<ma::agent::policy>Current local time: 2026\nfix the bug",
  "<ma::agent::policy>p</ma::agent::policy>hello",
  'Fix<ma::emit::diff a="1"/>the bug',
  "<ma::x>Fix bug</ma::x>",
  "<ma::x/>",
  "a < b and <map>",
  'fix the bug <ma::agent::policy x="1">secret</ma::agent::policy> now',
  'a <ma::agent::raw-output path="p" /> b </ma::x> c',
  "  fix the <ma::x>y</ma::x>login bug\n\n\n\nnow ",
  "Fix <ma::emit::diff /> login bug",
  "<ma::a>1</ma::a> mid <ma::b>2</ma::b> end",
  "x </ma::agent::policy> y",
  "<ma::a>outer <ma::b>inner</ma::b> tail</ma::a> after",
  "no tags at all",
]

describe("stripLenient: the old summary regexes", () => {
  for (const t of CASES) {
    test(JSON.stringify(t).slice(0, 70), () => {
      expect(strip(t, SUMMARY)).toBe(oldSummary(t))
    })
  }
})

describe("stripLenient keepBody: the old title regex", () => {
  for (const t of [...CASES, "Fix bug <ma::agent::raw-output path="]) {
    test(JSON.stringify(t).slice(0, 70), () => {
      expect(strip(t, TITLE)).toBe(oldTitle(t))
    })
  }
})

describe("stripLenient default: the title plugin stripMaTags", () => {
  // Not these cases. 7: a start part with no end part and a line feed: the
  // lenient strip also removes the rest of that line (the summary rule).
  // 5 and 6: old regex leaks (a self-closing part read as a start part; a
  // nest of the same name leaks " LEAK"). The lenient strip gives "REAL" and
  // " REAL", the same as the summary rule.
  const skip = new Set([CASES[5], CASES[6], CASES[7]])
  for (const t of CASES.filter((c) => !skip.has(c))) {
    test(JSON.stringify(t).slice(0, 70), () => {
      expect(strip(t)).toBe(oldPlugin(t))
    })
  }
})

describe("stripLenient: more forms and options", () => {
  test("v2 and bare legacy forms are parts", () => {
    expect(strip("a<ma:policy>x</ma:policy>b")).toBe("ab")
    expect(strip('a<mode-change from="x" />b')).toBe("ab")
    expect(strip("a</ma:policy>b", TITLE)).toBe("a b")
  })
  test("a cut start part at the end goes; a cut part before a `<` stays", () => {
    expect(strip("Fix bug <ma::agent::raw-output path=", SUMMARY)).toBe("Fix bug  ")
    expect(strip("a <ma::x b <c>")).toBe("a <ma::x b <c>")
  })
  test("kinds keeps the other kinds", () => {
    const t = "<ma::agent::policy>p</ma::agent::policy> <ma::agent::tasks>t</ma::agent::tasks>"
    expect(strip(t, { kinds: ["tasks"] })).toBe("<ma::agent::policy>p</ma::agent::policy> ")
  })
  test("a name must end at a space, `/`, `>` or the text end", () => {
    expect(strip("<ma::x+y>z")).toBe("<ma::x+y>z")
  })
  test("deep nests go as one range (no pass limit)", () => {
    const t = `${"<ma::a>".repeat(12)}x${"</ma::a>".repeat(12)} REAL`
    expect(strip(t, SUMMARY)).toBe("  REAL")
  })
  test("a `>` in a quoted value does not end the part (m4)", () => {
    expect(strip('a <ma::agent::raw-output path="x>y" size="1" />')).toBe("a ")
    expect(strip('a <ma::agent::raw-output path="x>y" /> keep\nnext')).toBe("a  keep\nnext")
    expect(strip("a <ma::agent::raw-output path='x>y' />", TITLE)).toBe("a  ")
    expect(strip('a <ma::agent::policy note="x>y">B</ma::agent::policy> c')).toBe("a  c")
    expect(leading('<ma::agent::raw-output path="x>y" /> z')?.span).toEqual({ start: 0, end: 36 })
  })
})

describe("leadingNode", () => {
  test("a complete node at the first non-space character", () => {
    const n = leading('  <ma::agent::tasks total="1">x</ma::agent::tasks> rest')
    expect(n?.kind).toBe("tasks")
    expect(n?.span).toEqual({ start: 2, end: 50 })
  })
  test("a start part only, also a cut one", () => {
    expect(leading('<ma::agent::tasks total="1">')?.kind).toBe("tasks")
    expect(leading('<ma::agent::tasks total="1">')?.attrs).toEqual({ total: "1" })
    expect(leading("\t<ma::agent::tasks")?.kind).toBe("tasks")
    expect(leading("<mode-change>")?.kind).toBe("mode-change")
    expect(leading('<MA::AGENT::TASKS total="1">')?.kind).toBe("tasks")
    expect(leading("<ma::agent::inline-ack/>")?.kind).toBe("inline-ack")
    expect(leading("<ma::agent::tasks <x>")?.span).toEqual({ start: 0, end: 17 })
  })
  test("no node at the start", () => {
    expect(leading("")).toBeUndefined()
    expect(leading("hello <ma::agent::tasks>")).toBeUndefined()
    expect(leading("</ma::agent::tasks>")).toBeUndefined()
    expect(leading("<unknown::tag>")).toBeUndefined()
    expect(leading("<map>")).toBeUndefined()
    expect(leading("ma::agent::tasks")).toBeUndefined()
    expect(leading("<ma::agent::tasks+x>")).toBeUndefined()
  })
})

describe("linear time (M1)", () => {
  const time = (f: () => void): number => {
    f()
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      f()
      best = Math.min(best, performance.now() - t0)
    }
    return best
  }
  const html = (kb: number) => "<div>a</div>".repeat(Math.ceil((kb * 1024) / 12))
  const opens = (kb: number) => "<ma::a>x".repeat(Math.ceil((kb * 1024) / 8))
  const closes = (kb: number) => "</ma::a>x".repeat(Math.ceil((kb * 1024) / 9))
  const expectLinear = (a: number, b: number): void => {
    expect(b).toBeLessThan(50)
    if (a >= 2) expect(b / a).toBeLessThan(8)
  }
  for (const [name, make] of [
    ["html", html],
    ["lone start parts", opens],
    ["lone end parts", closes],
  ] as const) {
    test(`stripLenient ${name}: 192 KB below 50 ms, ratio to 48 KB below 8`, () => {
      if (process.env.CI) return
      const small = make(48)
      const big = make(192)
      expectLinear(
        time(() => strip(small, SUMMARY)),
        time(() => strip(big, SUMMARY)),
      )
      expectLinear(
        time(() => strip(small, TITLE)),
        time(() => strip(big, TITLE)),
      )
    })
  }
})
