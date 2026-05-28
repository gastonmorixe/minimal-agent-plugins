import { describe, expect, it } from "bun:test"

import {
  approxTokensForFile,
  approxTokensForMany,
  formatTokens,
  type TokenDeps,
  tokenSeverity,
} from "./tokens.ts"

function mkDeps(
  files: Record<string, { body: string; mtimeNs: string }>,
  initialCache: Record<string, { mtimeNs: string; tokens: number }> = {},
): TokenDeps & { writes: number; cache: Record<string, { mtimeNs: string; tokens: number }> } {
  const cache = { ...initialCache }
  let writes = 0
  return {
    readFile: (p: string) => (p in files ? files[p]!.body : null),
    stat: (p: string) =>
      p in files ? { mtimeNs: files[p]!.mtimeNs, size: files[p]!.body.length } : null,
    readCache: () => cache,
    writeCache: (next: Record<string, { mtimeNs: string; tokens: number }>) => {
      writes++
      // Mutate in place so we can inspect from the test. Self-pass is
      // a legal contract (production fn reuses the readCache ref), so
      // guard against the clear-then-reassign self-erase.
      if (next === cache) return
      for (const k of Object.keys(cache)) delete cache[k]
      Object.assign(cache, next)
    },
    get writes() {
      return writes
    },
    get cache() {
      return cache
    },
  } as never
}

describe("approxTokensForFile", () => {
  it("computes ceil(bytes/4) on cache miss", () => {
    const deps = mkDeps({ "/x/skill.md": { body: "a".repeat(800), mtimeNs: "1" } })
    expect(approxTokensForFile("/x/skill.md", deps)).toBe(200)
  })

  it("writes the cache on miss", () => {
    const deps = mkDeps({ "/x/skill.md": { body: "a".repeat(800), mtimeNs: "1" } })
    approxTokensForFile("/x/skill.md", deps)
    expect((deps as never as { writes: number }).writes).toBe(1)
    expect(
      (deps as never as { cache: Record<string, { tokens: number }> }).cache["/x/skill.md"]!.tokens,
    ).toBe(200)
  })

  it("serves from cache when mtime matches (no readFile call)", () => {
    let reads = 0
    const deps = mkDeps({ "/x/skill.md": { body: "a".repeat(800), mtimeNs: "1" } })
    const wrapped = {
      ...deps,
      readFile: (p: string) => {
        reads++
        return deps.readFile(p)
      },
    }
    // First call: miss → read.
    approxTokensForFile("/x/skill.md", wrapped)
    expect(reads).toBe(1)
    // Second call: hit → no read.
    approxTokensForFile("/x/skill.md", wrapped)
    expect(reads).toBe(1)
  })

  it("invalidates cache on mtime change", () => {
    const files = { "/x/skill.md": { body: "a".repeat(400), mtimeNs: "1" } }
    const deps = mkDeps(files)
    expect(approxTokensForFile("/x/skill.md", deps)).toBe(100)
    files["/x/skill.md"] = { body: "a".repeat(1200), mtimeNs: "2" }
    expect(approxTokensForFile("/x/skill.md", deps)).toBe(300)
  })

  it("returns undefined for missing files", () => {
    const deps = mkDeps({})
    expect(approxTokensForFile("/nope", deps)).toBeUndefined()
  })
})

describe("approxTokensForMany", () => {
  it("batches reads through one cache read+write", () => {
    let cacheReads = 0
    let cacheWrites = 0
    const files = {
      "/a": { body: "a".repeat(400), mtimeNs: "1" },
      "/b": { body: "a".repeat(800), mtimeNs: "1" },
      "/c": { body: "a".repeat(1200), mtimeNs: "1" },
    }
    const deps = mkDeps(files)
    const wrapped: TokenDeps = {
      readFile: deps.readFile,
      stat: deps.stat,
      readCache: () => {
        cacheReads++
        return deps.readCache()
      },
      writeCache: (c) => {
        cacheWrites++
        deps.writeCache(c)
      },
    }
    const out = approxTokensForMany(["/a", "/b", "/c"], wrapped)
    expect(cacheReads).toBe(1)
    expect(cacheWrites).toBe(1)
    expect(out.get("/a")).toBe(100)
    expect(out.get("/b")).toBe(200)
    expect(out.get("/c")).toBe(300)
  })

  it("does not write cache when all entries are cache hits", () => {
    const initial = {
      "/a": { mtimeNs: "1", tokens: 100 },
      "/b": { mtimeNs: "1", tokens: 200 },
    }
    const files = {
      "/a": { body: "a".repeat(400), mtimeNs: "1" },
      "/b": { body: "a".repeat(800), mtimeNs: "1" },
    }
    const deps = mkDeps(files, initial)
    approxTokensForMany(["/a", "/b"], deps)
    expect((deps as never as { writes: number }).writes).toBe(0)
  })
})

describe("formatTokens", () => {
  it("formats sub-1k with 't' suffix", () => {
    expect(formatTokens(750)).toBe("~750t")
    expect(formatTokens(999)).toBe("~999t")
  })

  it("formats 1k–9.9k with one decimal", () => {
    expect(formatTokens(1000)).toBe("~1.0k")
    expect(formatTokens(2100)).toBe("~2.1k")
    expect(formatTokens(9900)).toBe("~9.9k")
  })

  it("formats ≥10k as rounded integer 'k'", () => {
    expect(formatTokens(10_000)).toBe("~10k")
    expect(formatTokens(12_400)).toBe("~12k")
    expect(formatTokens(149_500)).toBe("~150k")
  })

  it("returns empty string for undefined", () => {
    expect(formatTokens(undefined)).toBe("")
  })
})

describe("tokenSeverity", () => {
  it("bands are inclusive-lower / exclusive-upper", () => {
    expect(tokenSeverity(0)).toBe("cheap")
    expect(tokenSeverity(999)).toBe("cheap")
    expect(tokenSeverity(1000)).toBe("normal")
    expect(tokenSeverity(2999)).toBe("normal")
    expect(tokenSeverity(3000)).toBe("notable")
    expect(tokenSeverity(7999)).toBe("notable")
    expect(tokenSeverity(8000)).toBe("heavy")
    expect(tokenSeverity(19_999)).toBe("heavy")
    expect(tokenSeverity(20_000)).toBe("very-heavy")
  })

  it("undefined → unknown", () => {
    expect(tokenSeverity(undefined)).toBe("unknown")
  })
})
