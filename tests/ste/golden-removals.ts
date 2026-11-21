/**
 * Intended removals for the golden leaf diff of `ste-golden-shape.test.ts`:
 * whole `#` sections that a `text` leaf may lose, and goldens that may be gone
 * since the merge base. Remove each entry when main has the new goldens.
 *
 * @module tests/ste/golden-removals
 */

/** One intended removal of a whole `#` section from a `text` leaf. */
export interface SectionRemoval {
  /** The heading line of the removed section, for example `# Tool loop safety`. */
  heading: string
  /** Why the section is gone. */
  source: string
}

/**
 * Intended section removals. A `text` leaf may lose the section that starts
 * with `\n\n<heading>\n` and ends before the next `\n\n# ` (or at the end),
 * with no other change. The section may hold `<ma::...>` tags. Remove an
 * entry when main has the new goldens, as for {@link SCHEMA_ADDITIONS}.
 */
export const SECTION_REMOVALS: readonly SectionRemoval[] = []

/**
 * Goldens that are intended to be gone since the merge base. Remove an entry
 * when main no longer has the golden.
 */
export const DELETED_GOLDENS: ReadonlyArray<{ golden: string; source: string }> = []

/**
 * The text with the section of `heading` removed, or null when the text has
 * no such section.
 *
 * @param text - A `text` leaf.
 * @param heading - The heading line of the section.
 * @returns The text without the section, or null.
 */
export function withoutSection(text: string, heading: string): string | null {
  const start = text.indexOf(`\n\n${heading}\n`)
  if (start < 0) return null
  const next = text.indexOf("\n\n# ", start + 2)
  return text.slice(0, start) + (next < 0 ? "" : text.slice(next))
}

/**
 * True when a `tag` difference is exactly one {@link SECTION_REMOVALS} entry.
 *
 * @param before - The merge-base leaf.
 * @param after - The current leaf.
 * @param removals - The allowlist (a test passes its own).
 * @returns Whether the difference is allowed.
 */
export function isAllowedRemoval(
  before: unknown,
  after: unknown,
  removals: readonly SectionRemoval[] = SECTION_REMOVALS,
): boolean {
  if (typeof before !== "string" || typeof after !== "string") return false
  return removals.some((r) => withoutSection(before, r.heading) === after)
}
