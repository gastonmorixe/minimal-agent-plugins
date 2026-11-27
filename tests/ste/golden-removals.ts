/**
 * Intended removals for the golden leaf diff of `ste-golden-shape.test.ts`:
 * whole `#` sections and whole `<ma::sys::...>` blocks that a `text` leaf may
 * lose, and goldens that may be gone
 * since the merge base. Remove each entry when main has the new goldens.
 *
 * @module tests/ste/golden-removals
 */

import { pluginSideband } from "../support/sideband.ts"

/** The real sideband API. It renders the block tags. */
const SB = await pluginSideband()

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
export const SECTION_REMOVALS: readonly SectionRemoval[] = [
  {
    heading: "# Tool output conventions",
    source:
      "core removed the toolOutputConventions slot; the harness still writes blobs and the raw-output footer",
  },
]

/** One intended removal of a whole `<ma::sys::ROLE name="NAME">` block from a `text` leaf. */
export interface BlockRemoval {
  /** The role in the tag, for example `tool` for `<ma::sys::tool name="Fetch">`. */
  role: string
  /** The value of the `name` attribute. */
  name: string
  /** Why the block is gone. */
  source: string
}

/**
 * Intended block removals. A `text` leaf may lose a whole block that starts
 * with `<ma::sys::ROLE name="NAME">` and ends with `</ma::sys::ROLE>`, with
 * one `\n\n` separator and no other change. Many blocks can go from one leaf.
 * Remove an entry when main has the new goldens.
 */
export const BLOCK_REMOVALS: readonly BlockRemoval[] = []

/**
 * One intended trim of a block that stays in a `text` leaf. It is used only
 * when the same leaf also has a tag difference, for example a
 * {@link BLOCK_REMOVALS} entry. The words of the block may change. Its tags
 * must stay equal and in order, except the tag names in `dropTags`, which may
 * go. All text out of the listed blocks must stay byte-identical.
 */
export interface BlockTrim {
  /** The role in the tag, for example `mode`. */
  role: string
  /** The value of the `name` attribute. */
  name: string
  /** Tag names that the trim may remove from the block, for example `ma::agent::mode-active`. */
  dropTags: readonly string[]
  /** Why the block changed. */
  source: string
}

/** Intended block trims. Remove an entry when main has the new goldens. */
export const BLOCK_TRIMS: readonly BlockTrim[] = []

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
 * The text with one whole `<ma::sys::ROLE name="NAME">` block removed, with one
 * `\n\n` separator. Returns null when the text has no such block. The open tag
 * must match `name="NAME"` exactly and must start the text or follow `\n\n`.
 * The block ends at the first `</ma::sys::ROLE>` that ends the text or
 * precedes `\n\n`. A block that holds a second open tag of the same role is
 * not matched, so the match never spans two blocks.
 *
 * @param text - A `text` leaf.
 * @param role - The role in the tag, for example `tool`.
 * @param name - The value of the `name` attribute.
 * @returns The text without the block, or null.
 */
export function withoutBlock(text: string, role: string, name: string): string | null {
  const span = blockSpan(text, role, name)
  if (span === null) return null
  const { start, end } = span
  if (end === text.length) {
    // Last block: take the separator before it, when there is one.
    return start === 0 ? "" : text.slice(0, start - 2)
  }
  return text.slice(0, start) + text.slice(end + 2)
}

/** The place of one whole block in a text: open tag start to close tag end. */
export interface BlockSpan {
  /** Index of the open tag. */
  start: number
  /** Index after the close tag. */
  end: number
}

/**
 * The span of one whole `<ma::sys::ROLE name="NAME">` block, with the rules of
 * {@link withoutBlock}: it starts the text or follows `\n\n`, it ends the text
 * or precedes `\n\n`, and it holds no second open tag of the same role.
 *
 * @param text - A `text` leaf.
 * @param role - The role in the tag, for example `tool`.
 * @param name - The value of the `name` attribute.
 * @returns The span, or null when the text has no such block.
 */
export function blockSpan(text: string, role: string, name: string): BlockSpan | null {
  // The real codec writes the tags, so this file holds no wire form.
  const open = SB.open(role, { attrs: { name } })
  const close = SB.close(role)
  // The open tag with no attribute ends in `>`. With an attribute, a space
  // comes after the qualified name.
  const anyOpen = `${SB.open(role).slice(0, -1)} `
  if (open === "" || close === "") return null
  let from = 0
  for (;;) {
    const start = text.indexOf(open, from)
    if (start < 0) return null
    from = start + 1
    if (start !== 0 && text.slice(start - 2, start) !== "\n\n") continue
    const bodyStart = start + open.length
    const closeAt = text.indexOf(close, bodyStart)
    if (closeAt < 0) return null
    if (text.slice(bodyStart, closeAt).includes(anyOpen)) continue
    const end = closeAt + close.length
    if (end !== text.length && text.slice(end, end + 2) !== "\n\n") continue
    return { start, end }
  }
}

/**
 * Apply each {@link SECTION_REMOVALS} and {@link BLOCK_REMOVALS} entry that is
 * present, in sequence (sections first, then blocks).
 *
 * @param before - The merge-base leaf.
 * @param removals - The section allowlist.
 * @param blocks - The block allowlist.
 * @returns The text after the removals, and the count of applied entries.
 */
export function applyRemovals(
  before: string,
  removals: readonly SectionRemoval[] = SECTION_REMOVALS,
  blocks: readonly BlockRemoval[] = BLOCK_REMOVALS,
): { text: string; applied: number } {
  let text = before
  let applied = 0
  for (const r of removals) {
    const next = withoutSection(text, r.heading)
    if (next === null) continue
    text = next
    applied++
  }
  for (const b of blocks) {
    const next = withoutBlock(text, b.role, b.name)
    if (next === null) continue
    text = next
    applied++
  }
  return { text, applied }
}

/**
 * True when a `tag` difference is exactly the {@link SECTION_REMOVALS} and
 * {@link BLOCK_REMOVALS} entries that are present in `before`. Each entry that
 * is present is removed in sequence (sections first, then blocks). An entry
 * that is absent in `before` is skipped. At least one entry must apply.
 *
 * @param before - The merge-base leaf.
 * @param after - The current leaf.
 * @param removals - The section allowlist (a test passes its own).
 * @param blocks - The block allowlist (a test passes its own).
 * @returns Whether the difference is allowed.
 */
export function isAllowedRemoval(
  before: unknown,
  after: unknown,
  removals: readonly SectionRemoval[] = SECTION_REMOVALS,
  blocks: readonly BlockRemoval[] = BLOCK_REMOVALS,
): boolean {
  if (typeof before !== "string" || typeof after !== "string") return false
  const { text, applied } = applyRemovals(before, removals, blocks)
  return applied > 0 && text === after
}

/**
 * True when a `tag` difference of a `text` leaf is allowed: a pure removal
 * ({@link isAllowedRemoval}) or a removal plus block trims ({@link isAllowedTrim}).
 *
 * @param before - The merge-base leaf.
 * @param after - The current leaf.
 * @param tags - Every protocol tag of a text, in order.
 * @param removals - The section allowlist (a test passes its own).
 * @param blocks - The block allowlist (a test passes its own).
 * @param trims - The trim allowlist (a test passes its own).
 * @returns Whether the difference is allowed.
 */
export function isAllowedTextChange(
  before: unknown,
  after: unknown,
  tags: (text: string) => string[],
  removals: readonly SectionRemoval[] = SECTION_REMOVALS,
  blocks: readonly BlockRemoval[] = BLOCK_REMOVALS,
  trims: readonly BlockTrim[] = BLOCK_TRIMS,
): boolean {
  return (
    isAllowedRemoval(before, after, removals, blocks) ||
    isAllowedTrim(before, after, tags, trims, removals, blocks)
  )
}

/** The tag name of a tag: `<ma::agent::mode-active id="x" />` gives `ma::agent::mode-active`. */
function tagName(tag: string): string {
  const body = tag.startsWith("</") ? tag.slice(2) : tag.slice(1)
  const end = body.search(/[\s/>]/)
  return end < 0 ? body : body.slice(0, end)
}

/** A text cut at the listed blocks: the text out of the blocks, and each block. */
function cutAtBlocks(
  text: string,
  trims: readonly BlockTrim[],
): { outside: string[]; inside: Map<BlockTrim, string> } | null {
  const found: { trim: BlockTrim; span: BlockSpan }[] = []
  for (const trim of trims) {
    const span = blockSpan(text, trim.role, trim.name)
    if (span !== null) found.push({ trim, span })
  }
  found.sort((a, b) => a.span.start - b.span.start)
  const outside: string[] = []
  const inside = new Map<BlockTrim, string>()
  let at = 0
  for (const { trim, span } of found) {
    if (span.start < at) return null
    outside.push(text.slice(at, span.start))
    inside.set(trim, text.slice(span.start, span.end))
    at = span.end
  }
  outside.push(text.slice(at))
  return { outside, inside }
}

/**
 * True when a `tag` difference is the listed removals ({@link applyRemovals},
 * at least one must apply) plus word changes in {@link BLOCK_TRIMS} blocks.
 * Out of the trimmed blocks the text must be byte-identical. Each trimmed
 * block must be in both texts, and keep its tags equal and in order, less the
 * tag names in its `dropTags`.
 *
 * @param before - The merge-base leaf.
 * @param after - The current leaf.
 * @param tags - Every protocol tag of a text, in order (the golden-shape test gives `maTags`).
 * @param trims - The trim allowlist (a test passes its own).
 * @param removals - The section allowlist.
 * @param blocks - The block allowlist.
 * @returns Whether the difference is allowed.
 */
export function isAllowedTrim(
  before: unknown,
  after: unknown,
  tags: (text: string) => string[],
  trims: readonly BlockTrim[] = BLOCK_TRIMS,
  removals: readonly SectionRemoval[] = SECTION_REMOVALS,
  blocks: readonly BlockRemoval[] = BLOCK_REMOVALS,
): boolean {
  if (typeof before !== "string" || typeof after !== "string") return false
  const { text, applied } = applyRemovals(before, removals, blocks)
  if (applied === 0) return false
  const a = cutAtBlocks(text, trims)
  const b = cutAtBlocks(after, trims)
  if (a === null || b === null || a.inside.size === 0) return false
  if (a.inside.size !== b.inside.size) return false
  if (a.outside.join("\u0000") !== b.outside.join("\u0000")) return false
  for (const [trim, blockA] of a.inside) {
    const blockB = b.inside.get(trim)
    if (blockB === undefined) return false
    const kept = tags(blockA).filter((t) => !trim.dropTags.includes(tagName(t)))
    if (kept.join("\u0000") !== tags(blockB).join("\u0000")) return false
  }
  return true
}
