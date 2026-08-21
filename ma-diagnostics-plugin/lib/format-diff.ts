/**
 * Minimal line-based unified-diff generator.
 *
 * The diagnostics plugin needs to show a model WHAT a formatter would change
 * (biome's JSON carries no content for `format` findings, just "would have
 * printed"). A full LCS diff is overkill for formatter output: formatters
 * mostly rewrite contiguous runs of lines, so a simple run-based comparison
 * (equal-prefix / equal-suffix / middle as replacement) covers the real cases,
 * stays deterministic, and is trivially unit-testable. Pure functions.
 *
 * @module plugins/diagnostics/lib/format-diff
 */

/** One changed region between two texts, unified-diff style. */
export interface FormatDiff {
  /** 1-based line in the ORIGINAL text where the hunk starts (context incl.). */
  startLine: number
  /** Hunk body: `" "` context, `"-"` removed, `"+"` added. */
  lines: string[]
}

/** Split into lines; trailing newline yields no phantom empty last element. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
}

/**
 * Compute the single changed region between `before` and `after`. Returns null
 * when the texts normalize to identical lines.
 */
export function formatDiff(before: string, after: string): FormatDiff | null {
  const a = splitLines(before)
  const b = splitLines(after)

  // Equal prefix length.
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  // Equal suffix length (never overlapping the prefix).
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

  if (p + s >= a.length && p + s >= b.length) return null

  const removed = a.slice(p, a.length - s)
  const added = b.slice(p, b.length - s)
  // One unchanged line of context on each side keeps the hunk locatable
  // without bloating the note.
  const ctxStart = Math.max(0, p - 1)
  const ctxAfter = Math.min(a.length, p + removed.length + 1)
  const tailCtx = Math.max(0, ctxAfter - (p + removed.length))
  const headCtx = p - ctxStart

  const lines: string[] = []
  for (let i = 0; i < headCtx; i++) lines.push(` ${a[ctxStart + i]}`)
  for (const l of removed) lines.push(`-${l}`)
  for (const l of added) lines.push(`+${l}`)
  for (let i = 0; i < tailCtx; i++) {
    lines.push(` ${a[p + removed.length + i]}`)
  }
  return { startLine: ctxStart + 1, lines }
}
