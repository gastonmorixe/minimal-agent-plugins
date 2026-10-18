/**
 * Token-cost helpers for the autocomplete kit.
 *
 * A cheap approximation: bytes / 4, with an mtime-keyed in-memory cache so a
 * footer repaint never re-reads the same file. Providers that already know a
 * cost can set `item.tokens` directly and skip this module.
 *
 * @module ma-autocomplete-kit/tokens
 */

import { statSync, readFileSync } from "node:fs"

export interface TokenDeps {
  /** Read a file body. Returns null on miss. */
  readFile(path: string): string | null
  /** Stat a path. Returns null on miss. */
  stat(path: string): { size: number; mtimeMs: number } | null
  /** Cache keyed by path, holding mtimeMs and tokens. */
  cache: Map<string, { mtimeMs: number; tokens: number }>
}

/** Default fs deps wired to real Node fs. */
export function defaultDeps(): TokenDeps {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8")
      } catch {
        return null
      }
    },
    stat: (p) => {
      try {
        const s = statSync(p)
        return { size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    },
    cache: new Map(),
  }
}

/** Approximate token count for a body: bytes / 4, rounded up. */
export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4)
}

/**
 * Approximate tokens for one file, cached by mtime. Returns undefined when
 * the file is unreadable.
 */
export function approxTokensForFile(path: string, deps: TokenDeps): number | undefined {
  const s = deps.stat(path)
  if (!s) return undefined
  const hit = deps.cache.get(path)
  if (hit && hit.mtimeMs === s.mtimeMs) return hit.tokens
  const body = deps.readFile(path)
  if (body === null) return undefined
  const tokens = approxTokens(body)
  deps.cache.set(path, { mtimeMs: s.mtimeMs, tokens })
  return tokens
}

/** Batch variant: returns a path-to-tokens map. */
export function approxTokensForMany(
  paths: readonly string[],
  deps: TokenDeps,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of paths) {
    const t = approxTokensForFile(p, deps)
    if (t !== undefined) out.set(p, t)
  }
  return out
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/** Severity band for a token count. Drives the chip color. */
export type TokenSeverity = "cheap" | "normal" | "notable" | "heavy" | "very-heavy" | "unknown"

/** Classify a token count into a severity band. */
export function tokenSeverity(tokens: number | undefined): TokenSeverity {
  if (tokens === undefined) return "unknown"
  if (tokens < 500) return "cheap"
  if (tokens < 2_000) return "normal"
  if (tokens < 6_000) return "notable"
  if (tokens < 20_000) return "heavy"
  return "very-heavy"
}

/** Format a token count compactly: 812, 4.2k, 120k. */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return ""
  if (tokens < 1_000) return String(tokens)
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${Math.round(tokens / 1_000)}k`
}
