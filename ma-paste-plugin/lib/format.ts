/**
 * Chip text of a paste ref (PLAN 4.4).
 *
 * @module lib/format
 */

const UNITS = ["kB", "MB", "GB", "TB"] as const

/**
 * SI size with one decimal: `999B`, `1.0kB`, `999.9kB`, `1.0MB`. A value
 * that rounds to 1000 of a unit goes to the next unit (999,950 B gives
 * `1.0MB`).
 */
export function formatSize(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0
  if (b < 1000) return `${b}B`
  let v = b / 1000
  let u = 0
  while (u < UNITS.length - 1 && Math.round(v * 10) / 10 >= 1000) {
    v /= 1000
    u++
  }
  return `${(Math.round(v * 10) / 10).toFixed(1)}${UNITS[u]}`
}

/** A non-negative int from a typed or string attr, else undefined. */
function intAttr(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/**
 * The chip label: `[Paste #<id> <size> <lines>L]`. When `known` is false (no
 * file in this session), the label is `[Paste #<id> missing]`.
 */
export function chipLabel(attrs: Record<string, unknown>, known: boolean): string {
  const id = typeof attrs.id === "string" ? attrs.id : "?"
  const parts = [`#${id}`]
  if (!known) {
    parts.push("missing")
  } else {
    const bytes = intAttr(attrs.bytes)
    const lines = intAttr(attrs.lines)
    if (bytes !== undefined) parts.push(formatSize(bytes))
    if (lines !== undefined) parts.push(`${lines}L`)
  }
  return `[Paste ${parts.join(" ")}]`
}
