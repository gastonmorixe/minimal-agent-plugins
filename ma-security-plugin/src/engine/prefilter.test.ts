import { describe, expect, it } from "bun:test"

import { buildAutomaton } from "./prefilter.ts"

const words = (a: ReturnType<typeof buildAutomaton>, text: string) =>
  a.scan(text).map((h) => [a.keywords[h.keyword], h.start, h.end])

describe("Aho-Corasick prefilter", () => {
  it("finds overlapping and nested keywords with positions", () => {
    const a = buildAutomaton(["he", "she", "his", "hers"])
    expect(words(a, "ushers")).toEqual([
      ["she", 1, 4],
      ["he", 2, 4],
      ["hers", 2, 6],
    ])
  })

  it("is case folded on keywords and text", () => {
    const a = buildAutomaton(["SK-ANT", "eyj"])
    expect(a.keywords).toEqual(["sk-ant", "eyj"])
    expect(words(a, "x Sk-AnT y EYJ")).toEqual([
      ["sk-ant", 2, 8],
      ["eyj", 11, 14],
    ])
  })

  it("drops empty and duplicate keywords and handles no keywords", () => {
    expect(buildAutomaton(["", "abc", "ABC"]).keywords).toEqual(["abc"])
    const e = buildAutomaton([])
    expect(e.scan("anything")).toEqual([])
    expect(e.present("anything").length).toBe(0)
  })

  it("handles repeated overlaps and the limit", () => {
    const a = buildAutomaton(["aa"])
    expect(a.scan("aaaa").map((h) => h.start)).toEqual([0, 1, 2])
    expect(a.scan("aaaa", 2).length).toBe(2)
  })

  it("present flags each keyword and ignores non-ASCII", () => {
    const a = buildAutomaton(["abc", "xyz", "é"])
    expect([...a.present("--ABC-- é")]).toEqual([1, 0, 1])
  })

  it("scans 1 MB fast", () => {
    const kws = [
      "sk-ant-oat01",
      "sk-or-v1",
      "eyj",
      "ghp_",
      "akia",
      "xoxb-",
      "hf_",
      "wfr_",
      "glpat-",
      "aiza",
    ]
    const a = buildAutomaton(kws)
    let text = ""
    const chunk = "lorem ipsum dolor sit amet, consectetur adipiscing elit sk-o ghp eyz akib\n"
    while (text.length < 1 << 20) text += chunk
    for (let i = 0; i < 3; i++) {
      a.present(text)
      a.scan(text)
    }
    const mb = text.length / (1 << 20)
    let best = Number.POSITIVE_INFINITY
    let bestScan = Number.POSITIVE_INFINITY
    let flags: Uint8Array = new Uint8Array(0)
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      flags = a.present(text)
      const t1 = performance.now()
      a.scan(text)
      const t2 = performance.now()
      best = Math.min(best, t1 - t0)
      bestScan = Math.min(bestScan, t2 - t1)
    }
    expect([...flags].every((f) => f === 0)).toBe(true)
    expect(best / mb).toBeLessThanOrEqual(15)
    expect(bestScan / mb).toBeLessThanOrEqual(15)
  })
})
