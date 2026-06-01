/**
 * Approximate token counter with mtime-keyed cache.
 *
 * Uses the standard 4-char-per-token heuristic. Reads file body bytes,
 * not visual width — that's what matters for context cost.
 *
 * Cache lives at `~/.minimal-agent/cache/ma-slash-menu/tokens.json` and is
 * keyed by `(absolute-path, mtime-ns)`. We re-read when mtime changes
 * (skill author edited the SKILL.md) and otherwise serve from cache.
 *
 * Dependency-injection friendly: pass `deps` for unit tests so we don't
 * touch the real filesystem.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Characters per token, standard heuristic. */
const CHARS_PER_TOKEN = 4

/**
 * Approximate token count from a file body using the bytes/4 heuristic.
 *
 * Counts UTF-8 *bytes*, not UTF-16 code units (`String.length`): a SKILL.md
 * with CJK or emoji content has far more bytes than code units, and token
 * cost tracks bytes. Matches the documented `Math.ceil(bytes / 4)`.
 */
function approxTokens(body: string): number {
  return Math.ceil(Buffer.byteLength(body, "utf8") / CHARS_PER_TOKEN)
}

/** Cache file location, overridable via env for tests. */
function defaultCachePath(): string {
  const home = process.env.HOME ?? "/tmp"
  return join(home, ".minimal-agent", "cache", "ma-slash-menu", "tokens.json")
}

interface CacheEntry {
  /** ns since epoch, matches `Stats.mtimeNs`. */
  mtimeNs: string
  /** Approximate token count. */
  tokens: number
}

type CacheShape = Record<string, CacheEntry>

export interface TokenDeps {
  readFile(path: string): string | null
  stat(path: string): { mtimeNs: string; size: number } | null
  readCache(): CacheShape
  writeCache(cache: CacheShape): void
}

function fsReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function fsStat(path: string): { mtimeNs: string; size: number } | null {
  try {
    const s = statSync(path, { bigint: true })
    return { mtimeNs: s.mtimeNs.toString(), size: Number(s.size) }
  } catch {
    return null
  }
}

function fsReadCache(cachePath: string): CacheShape {
  try {
    const raw = readFileSync(cachePath, "utf8")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as CacheShape) : {}
  } catch {
    return {}
  }
}

function fsWriteCache(cachePath: string, cache: CacheShape): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8")
  } catch {
    // Cache write failure is non-fatal; we'll just re-compute next time.
  }
}

/** Default deps wired to real fs + the configured cache path. */
export function defaultDeps(cachePath: string = defaultCachePath()): TokenDeps {
  return {
    readFile: fsReadFile,
    stat: fsStat,
    readCache: () => fsReadCache(cachePath),
    writeCache: (cache) => fsWriteCache(cachePath, cache),
  }
}

/**
 * Approximate tokens for one file. Returns `undefined` if the file can't
 * be read.
 *
 * No I/O when a cache hit by mtime is found. Cache miss reads the body,
 * does `Math.ceil(bytes / 4)`, and writes back through `deps.writeCache`.
 */
export function approxTokensForFile(path: string, deps: TokenDeps): number | undefined {
  const stat = deps.stat(path)
  if (!stat) return undefined
  const cache = deps.readCache()
  const hit = cache[path]
  if (hit && hit.mtimeNs === stat.mtimeNs) return hit.tokens
  const body = deps.readFile(path)
  if (body === null) return undefined
  const tokens = approxTokens(body)
  cache[path] = { mtimeNs: stat.mtimeNs, tokens }
  deps.writeCache(cache)
  return tokens
}

/**
 * Batch helper — re-uses the cache map for the duration of the call so a
 * provider listing N skills does O(1) cache reads, not O(N).
 */
export function approxTokensForMany(
  paths: string[],
  deps: TokenDeps,
): Map<string, number | undefined> {
  const cache = deps.readCache()
  const out = new Map<string, number | undefined>()
  let dirty = false
  for (const path of paths) {
    const stat = deps.stat(path)
    if (!stat) {
      out.set(path, undefined)
      continue
    }
    const hit = cache[path]
    if (hit && hit.mtimeNs === stat.mtimeNs) {
      out.set(path, hit.tokens)
      continue
    }
    const body = deps.readFile(path)
    if (body === null) {
      out.set(path, undefined)
      continue
    }
    const tokens = approxTokens(body)
    cache[path] = { mtimeNs: stat.mtimeNs, tokens }
    out.set(path, tokens)
    dirty = true
  }
  if (dirty) deps.writeCache(cache)
  return out
}

/**
 * Format a token count for display: short, fits in ~5–6 cells.
 *
 *   < 1000        → "~750t"
 *   1000–9999     → "~2.1k"
 *   ≥ 10000       → "~12k"
 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return ""
  if (n < 1000) return `~${n}t`
  if (n < 10_000) {
    const k = n / 1000
    return `~${k.toFixed(1)}k`
  }
  return `~${Math.round(n / 1000)}k`
}

/**
 * Severity band for color grading the token chip.
 *
 *   < 1k     → "cheap"     (dim lime)
 *   1–3k     → "normal"    (faintWhite)
 *   3–8k     → "notable"   (gold)
 *   8–20k    → "heavy"     (dim red)
 *   > 20k    → "very-heavy" (bold red)
 */
export type Severity = "cheap" | "normal" | "notable" | "heavy" | "very-heavy" | "unknown"

export function tokenSeverity(n: number | undefined): Severity {
  if (n === undefined) return "unknown"
  if (n < 1000) return "cheap"
  if (n < 3000) return "normal"
  if (n < 8000) return "notable"
  if (n < 20_000) return "heavy"
  return "very-heavy"
}

export { CHARS_PER_TOKEN }
