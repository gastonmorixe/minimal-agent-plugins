import { describe, expect, it } from "bun:test"

import { fuzzyMatch, sortByScore } from "./fuzzy.ts"

describe("fuzzyMatch — empty query", () => {
  it("empty needle scores 0 with no matches", () => {
    const r = fuzzyMatch("config", "")
    expect(r.score).toBe(0)
    expect(r.matches).toEqual([])
  })
})

describe("fuzzyMatch — no match", () => {
  it("needle longer than haystack is rejected", () => {
    expect(fuzzyMatch("foo", "barbaz").score).toBe(-1)
  })

  it("missing chars produce -1", () => {
    expect(fuzzyMatch("config", "xyz").score).toBe(-1)
  })

  it("out-of-order chars produce -1", () => {
    // 'g' before 'c' — must be -1 since subsequence is ordered.
    expect(fuzzyMatch("config", "gc").score).toBe(-1)
  })
})

describe("fuzzyMatch — exact prefix", () => {
  it("prefix gets a huge score and per-char matches", () => {
    const r = fuzzyMatch("config", "conf")
    expect(r.score).toBeGreaterThan(1000)
    expect(r.matches).toEqual([0, 1, 2, 3])
  })

  it("exact equality beats prefix-of", () => {
    const a = fuzzyMatch("config", "config")
    const b = fuzzyMatch("configure", "config")
    expect(a.score).toBeGreaterThan(b.score)
  })

  it("case-insensitive", () => {
    const r = fuzzyMatch("Config", "conf")
    expect(r.score).toBeGreaterThan(1000)
    expect(r.matches).toEqual([0, 1, 2, 3])
  })
})

describe("fuzzyMatch — subsequence", () => {
  it("scattered match is positive but well below prefix", () => {
    const a = fuzzyMatch("swiftui-pro", "swp")
    const b = fuzzyMatch("swiftui-pro", "swi")
    expect(a.score).toBeGreaterThan(0)
    expect(b.score).toBeGreaterThan(a.score)
  })

  it("word-boundary hits score higher than mid-word", () => {
    // "ap" matches index 0,1 in "apple-development" (both word-start),
    // matches 4,5 in "swapped-helper" (mid-word).
    const a = fuzzyMatch("apple-development", "ap")
    const b = fuzzyMatch("swapped-helper", "ap")
    expect(a.score).toBeGreaterThan(b.score)
  })

  it("hyphen / underscore boundary contributes", () => {
    // Both 4-char subsequence "view" — "v" at index 0 vs index after `-`.
    const a = fuzzyMatch("view-port", "view")
    const b = fuzzyMatch("a-view-port", "view")
    expect(a.score).toBeGreaterThan(0)
    expect(b.score).toBeGreaterThan(0)
    // boundary-after-hyphen should still register the word-boundary bonus
    // on the 'v' (prev char is '-').
    expect(b.matches).toEqual([2, 3, 4, 5])
  })

  it("contiguous run beats scattered match for same needle", () => {
    // "test" matches indexes [0,1,2,3] (contiguous) vs scattered hits.
    const a = fuzzyMatch("test-runner", "test")
    const b = fuzzyMatch("t-e-s-t", "test")
    expect(a.score).toBeGreaterThan(b.score)
  })
})

describe("fuzzyMatch — returned match indexes", () => {
  it("matches index into haystack, not needle", () => {
    const r = fuzzyMatch("swift-concurrency-expert", "scnc")
    expect(r.score).toBeGreaterThan(0)
    expect(r.matches.length).toBe(4)
    // First match is the 's' at index 0.
    expect(r.matches[0]).toBe(0)
    // Indexes are strictly increasing.
    for (let i = 1; i < r.matches.length; i++) {
      expect(r.matches[i]!).toBeGreaterThan(r.matches[i - 1]!)
    }
  })
})

describe("sortByScore", () => {
  it("sorts descending by score, ties alphabetical", () => {
    const items = [
      { slug: "zebra", score: 10 },
      { slug: "alpha", score: 50 },
      { slug: "bravo", score: 50 },
      { slug: "yankee", score: 30 },
    ]
    sortByScore(items)
    expect(items.map((i) => i.slug)).toEqual(["alpha", "bravo", "yankee", "zebra"])
  })

  it("is stable enough for predictable display", () => {
    const items = [
      { slug: "config", score: 1140 },
      { slug: "context", score: 1140 },
    ]
    sortByScore(items)
    // Same score → alphabetical → "config" before "context".
    expect(items[0]!.slug).toBe("config")
  })
})
