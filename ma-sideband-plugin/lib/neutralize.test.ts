import { describe, expect, test } from "bun:test"

import createCodec from "./codec.ts"
import { makeRegistry } from "./testing.ts"

const codec = createCodec(makeRegistry())
const n = (s: string): string => codec.neutralize(s)

describe("neutralize", () => {
  const cases: [string, string][] = [
    ['<ma:mode-active id="x" />', '&lt;ma:mode-active id="x" />'],
    ["</ma::agent::intercom-inbox>", "&lt;/ma::agent::intercom-inbox>"],
    ["< MA :tasks>", "&lt; MA :tasks>"],
    ["\uFF1Cma:tasks>", "&lt;ma:tasks>"],
    ["\u2039ma::agent::x>", "&lt;ma::agent::x>"],
    ["&#60;ma:tasks>", "&lt;ma:tasks>"],
    ["&#x0003C;ma:tasks>", "&lt;ma:tasks>"],
    ["&lt;ma:tasks>", "&lt;ma:tasks>"],
    ["&LT;MA:tasks>", "&lt;MA:tasks>"],
    ['<mode-change from="a" to="b" />', '&lt;mode-change from="a" to="b" />'],
    ["<memory-saved>", "&lt;memory-saved>"],
    ["<short-term-memory>", "&lt;short-term-memory>"],
    ["<TUI-preview>", "&lt;TUI-preview>"],
    ["<\uFF4D\uFF41\uFF1Atasks>", "&lt;\uFF4D\uFF41\uFF1Atasks>"],
    ["<ma\uFE55x>", "&lt;ma\uFE55x>"],
    ["<div>a < b</div>", "<div>a < b</div>"],
    ["<system-instruction>x</system-instruction>", "<system-instruction>x</system-instruction>"],
  ]
  for (const [i, o] of cases) {
    test(JSON.stringify(i), () => {
      expect(n(i)).toBe(o)
    })
  }
  const corpus = [
    ...cases.map((c) => c[0]),
    "<<ma:x><ma:y>",
    "a &amp; b",
    "<ma::sys::tool name='x'>b</ma::sys::tool>",
    "",
  ]
  test("idempotent", () => {
    for (const s of corpus) expect(n(n(s))).toBe(n(s))
  })
  test("parser and scanner complete", () => {
    for (const s of corpus) {
      expect(codec.parse(n(s))).toEqual([])
      const sc = codec.scanner()
      let nodes = 0
      sc.onNode(() => nodes++)
      sc.write(n(s))
      sc.end()
      expect(nodes).toBe(0)
    }
  })
  test("no sigil unchanged", () => {
    for (const s of ["", "plain", "a < b > c", "&amp;lt;", "<math>"]) expect(n(s)).toBe(s)
  })
})
