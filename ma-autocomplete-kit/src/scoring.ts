/**
 * Item scoring + filtering pipeline.
 *
 * Takes raw provider items + the current query and returns the scored,
 * sorted list ready for the renderer. Pure function, no I/O.
 *
 * @module ma-autocomplete-kit/scoring
 */

import { fuzzyMatch, sortByScore } from "./fuzzy.ts"
import type { Category, Item, ScoredItem } from "./types.ts"

/**
 * Score items against a query, drop non-matches, sort best-first.
 *
 * Scoring rules:
 *   - Match against the slug only (description is dim secondary text).
 *   - Empty query means every item passes with score 0 (alpha order).
 *   - Negative-scored items are dropped.
 */
export function scoreItems(items: Item[], query: string): ScoredItem[] {
  if (query === "") {
    return items.map((item) => ({ ...item, score: 0, slugMatches: [] }))
  }
  const scored: ScoredItem[] = []
  for (const item of items) {
    const m = fuzzyMatch(item.slug, query)
    if (m.score < 0) continue
    scored.push({ ...item, score: m.score, slugMatches: m.matches })
  }
  sortByScore(scored)
  return scored
}

/** Filter items to the categories a spec allows. Empty list means all. */
export function filterByCategories(
  items: readonly Item[],
  categories: readonly Category[] | undefined,
): Item[] {
  if (!categories || categories.length === 0) return [...items]
  const allowed = new Set<string>(categories)
  return items.filter((item) => allowed.has(item.category))
}

/**
 * Sort options. The default cost-blind ordering is fine most of the time.
 */
export type SortMode = "match-score" | "cost-asc" | "cost-desc"

/** Re-order a scored set per sort mode. Returns the input array. */
export function applySortMode(items: ScoredItem[], mode: SortMode): ScoredItem[] {
  if (mode === "match-score") return items
  if (mode === "cost-asc") {
    items.sort((a, b) => {
      const ta = a.tokens ?? Number.POSITIVE_INFINITY
      const tb = b.tokens ?? Number.POSITIVE_INFINITY
      if (Math.abs(a.score - b.score) >= 100) return b.score - a.score
      return ta - tb
    })
    return items
  }
  // cost-desc
  items.sort((a, b) => {
    const ta = a.tokens ?? -1
    const tb = b.tokens ?? -1
    if (Math.abs(a.score - b.score) >= 100) return b.score - a.score
    return tb - ta
  })
  return items
}
