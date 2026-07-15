import { describe, expect, it } from "bun:test"

import { fuzzyMatch, sortByScore } from "./fuzzy.ts"

describe("fuzzyMatch", () => {
  it("empty needle scores 0 with no matches", () => {
    expect(fuzzyMatch("Michelle", "")).toEqual({ score: 0, matches: [] })
  })

  it("exact name match scores highest", () => {
    const exact = fuzzyMatch("Michelle", "Michelle")
    const prefix = fuzzyMatch("Michelle", "Mich")
    expect(exact.score).toBeGreaterThan(prefix.score)
    expect(exact.matches).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it("prefix of short sid matches", () => {
    const m = fuzzyMatch("a1b2c3d4", "a1b2")
    expect(m.score).toBeGreaterThan(0)
    expect(m.matches).toEqual([0, 1, 2, 3])
  })

  it("subsequence of name matches with positive score", () => {
    const m = fuzzyMatch("Michelle", "mcl")
    expect(m.score).toBeGreaterThanOrEqual(0)
    expect(m.matches.length).toBe(3)
  })

  it("no match when needle can't be placed", () => {
    expect(fuzzyMatch("Michelle", "zzz").score).toBe(-1)
  })

  it("case-insensitive", () => {
    expect(fuzzyMatch("Michelle", "MIC").score).toBeGreaterThan(0)
  })
})

describe("sortByScore", () => {
  it("orders by score desc then slug alpha", () => {
    const items = [
      { score: 10, slug: "b" },
      { score: 20, slug: "a" },
      { score: 10, slug: "a" },
    ]
    sortByScore(items)
    expect(items.map((i) => i.slug)).toEqual(["a", "a", "b"])
    expect(items[0]!.score).toBe(20)
  })
})
