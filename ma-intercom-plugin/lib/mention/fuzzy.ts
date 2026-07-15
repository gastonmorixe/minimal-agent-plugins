/**
 * Subsequence fuzzy matcher for at-mention peer autocomplete.
 *
 * Same algorithm as ma-slash-menu-plugin: exact-prefix is preferred, word-
 * boundary hits score higher than mid-word, contiguous runs beat scattered
 * hits. Tuned for short names / short sids.
 *
 */

/**
 * Match `needle` as a subsequence of `haystack`.
 *
 * @returns `{score, matches}`. `score < 0` means no match; the caller should
 * drop the item. Empty needle → score 0 with no match indexes.
 */
export function fuzzyMatch(haystack: string, needle: string): { score: number; matches: number[] } {
  if (needle === "") return { score: 0, matches: [] }
  if (needle.length > haystack.length) return { score: -1, matches: [] }

  const hay = haystack.toLowerCase()
  const ndl = needle.toLowerCase()

  // Exact-prefix shortcut: huge score boost. Critical for "@Mic" → Michelle.
  if (hay.startsWith(ndl)) {
    const matches = Array.from({ length: ndl.length }, (_, i) => i)
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
