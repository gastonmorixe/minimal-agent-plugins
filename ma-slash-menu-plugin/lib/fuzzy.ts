/**
 * Subsequence fuzzy matcher.
 *
 * Returns a composite score plus the matched character indexes in the
 * haystack so the renderer can highlight them. Tuned for *short* slugs
 * (typically 3–30 chars): exact-prefix is overwhelmingly preferred,
 * word-boundary hits score higher than mid-word, contiguous runs beat
 * scattered hits.
 *
 * Algorithm:
 *   1. Normalize both sides to lowercase.
 *   2. Walk the needle, advancing through the haystack. Each needle
 *      char must appear (in order) somewhere in the haystack.
 *   3. While walking, accumulate per-match bonuses.
 *   4. Return -1 (no match) if any needle char can't be placed.
 *
 * @returns `{score, matches}`. `score < 0` means no match; the caller
 * should drop the item.
 */
export function fuzzyMatch(haystack: string, needle: string): { score: number; matches: number[] } {
  if (needle === "") return { score: 0, matches: [] }
  if (needle.length > haystack.length) return { score: -1, matches: [] }

  const hay = haystack.toLowerCase()
  const ndl = needle.toLowerCase()

  // Exact-prefix shortcut: huge score boost. Critical for "/conf" → /config.
  if (hay.startsWith(ndl)) {
    const matches = Array.from({ length: ndl.length }, (_, i) => i)
    // Exact-equal beats prefix-of, prefix-of beats internal.
    const exactBonus = hay.length === ndl.length ? 200 : 100
    return { score: 1000 + exactBonus + ndl.length * 10, matches }
  }

  const matches: number[] = []
  let h = 0
  let n = 0
  let score = 0
  let lastMatchIdx = -2 // -2 so first match doesn't count as contiguous

  while (n < ndl.length) {
    if (h >= hay.length) return { score: -1, matches: [] }
    if (hay[h] === ndl[n]) {
      matches.push(h)

      // Word-boundary bonus: match at start, or after `-` / `_` / `.`.
      const prev = h === 0 ? "" : hay[h - 1]
      if (h === 0) score += 20
      else if (prev === "-" || prev === "_" || prev === ".") score += 15

      // Contiguous-run bonus.
      if (h === lastMatchIdx + 1) score += 10

      // Earlier match bonus (decays).
      score += Math.max(0, 10 - h)

      // Base per-match credit.
      score += 5

      lastMatchIdx = h
      n++
    }
    h++
  }

  // Penalty proportional to unmatched-gap density.
  const span = matches[matches.length - 1]! - matches[0]! + 1
  const density = ndl.length / span
  score = Math.round(score * (0.5 + 0.5 * density))

  return { score, matches }
}

/** Sort scored items in-place: highest score first, ties alphabetical by slug. */
export function sortByScore<T extends { score: number; slug: string }>(items: T[]): T[] {
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.slug.localeCompare(b.slug)
  })
  return items
}
