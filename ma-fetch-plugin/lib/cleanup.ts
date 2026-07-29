/**
 * Whitespace cleanup for `markdown` and `text` fetch output.
 *
 * Three levels, applied only to `markdown` / `text` (HTML / links / original
 * pass through verbatim — newlines are syntactically significant in HTML
 * <pre>/<textarea>, link lists are one-per-line by design, original is the
 * raw byte stream from the backend).
 *
 *   "off"        — passthrough. Use when verbatim bytes matter (diffing,
 *                  research, downstream re-parse).
 *   "basic"      — the long-standing normalizer (default). Three idempotent
 *                  transforms:
 *                    1. rstrip every line (trailing space/tab)
 *                    2. collapse runs of 2+ blank-or-whitespace-only lines
 *                       into a single blank
 *                    3. strip leading + trailing blank lines
 *                  Markdown-rendering-safe: paragraph separation preserved.
 *   "aggressive" — basic, plus:
 *                    4. unicode whitespace fold: NBSP (U+00A0), the
 *                       U+2000–U+200A run, U+202F, U+205F, U+1680, U+3000
 *                       → ASCII space. Catches "blank-looking" lines that
 *                       survive rstrip because rstrip only strips ASCII
 *                       space/tab.
 *                    5. zero-width strip: ZWSP (U+200B), ZWNJ (U+200C),
 *                       ZWJ (U+200D), WORD JOINER (U+2060), BOM (U+FEFF)
 *                       → dropped. These never have semantic value in
 *                       agent-consumed plain text.
 *                    6. single-blank collapse: drop ALL remaining blank
 *                       lines. The block-element-per-paragraph markdown
 *                       converters (notably obscura on Bloomberg / GitHub /
 *                       Wikipedia) emit a blank line around every heading,
 *                       list, and link block. For agent reading that's
 *                       30 %+ wasted lines. Tradeoff: the resulting text
 *                       is not always valid markdown anymore (a heading
 *                       directly followed by a list item won't render as
 *                       a list in strict parsers). But the agent reads
 *                       lines, not rendered output.
 *
 * All levels are pure and idempotent. `applyCleanup(applyCleanup(x, L), L) === applyCleanup(x, L)`.
 *
 * The blob store ALWAYS persists the pre-cleanup bytes, so even at
 * `aggressive` the original is recoverable from the `<ma::agent::raw-output .../>`
 * footer's path. Cleanup shapes the model's view, not the on-disk truth.
 *
 * @module lib/cleanup
 */

export type CleanupLevel = "off" | "basic" | "aggressive"

export const CLEANUP_LEVELS: readonly CleanupLevel[] = ["off", "basic", "aggressive"] as const

/** Unicode "space"-category chars folded to ASCII U+0020.
 *  Deliberately narrow: only Zs (Space_Separator) + NBSP variants.
 *  Tab is NOT folded (markdown indent is meaningful). LF/CR are NOT
 *  folded (line structure is meaningful). */
const UNICODE_SPACES: ReadonlySet<string> = new Set([
  "\u00A0", // NO-BREAK SPACE
  "\u1680", // OGHAM SPACE MARK
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200A",
  "\u202F", // NARROW NO-BREAK SPACE
  "\u205F", // MEDIUM MATHEMATICAL SPACE
  "\u3000", // IDEOGRAPHIC SPACE
])

/** Format/zero-width chars dropped entirely. No semantic value in plain text. */
const ZERO_WIDTH: ReadonlySet<string> = new Set([
  "\u200B", // ZERO WIDTH SPACE
  "\u200C", // ZERO WIDTH NON-JOINER
  "\u200D", // ZERO WIDTH JOINER
  "\u2060", // WORD JOINER
  "\uFEFF", // BYTE-ORDER MARK / ZWNBSP
])

/** Single pass over the string: drop zero-width, fold unicode spaces. */
function foldUnicodeWhitespace(input: string): string {
  if (input.length === 0) return input
  // Fast-path: if no candidate code units, return verbatim. ASCII-only
  // input is the common case; bail out without allocating.
  if (!/[\u00A0\u1680\u2000-\u200D\u202F\u205F\u2060\u3000\uFEFF]/.test(input)) {
    return input
  }
  let out = ""
  // Iterate by code point (`for...of` on a string yields code points).
  // The chars we care about are all BMP, so this is byte-identical to
  // code-unit iteration, but consistent with future expansion.
  for (const c of input) {
    if (ZERO_WIDTH.has(c)) continue
    out += UNICODE_SPACES.has(c) ? " " : c
  }
  return out
}

/**
 * Basic cleanup (long-standing default). Markdown-rendering-safe:
 * preserves single blank lines as paragraph separators.
 */
export function cleanupBasic(input: string): string {
  if (input.length === 0) return input
  const lines = input.split("\n")
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[\t ]+$/, "")
  }
  const out: string[] = []
  let prevBlank = false
  for (const l of lines) {
    const isBlank = l.length === 0
    if (isBlank && prevBlank) continue
    out.push(l)
    prevBlank = isBlank
  }
  while (out.length > 0 && out[0] === "") out.shift()
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

/**
 * Aggressive cleanup. Folds unicode whitespace, strips zero-width
 * chars, runs basic, then drops ALL remaining blank lines.
 *
 * NOT markdown-rendering-safe: a heading directly followed by a list
 * may not parse as a list in strict renderers. Fine for agent-side
 * reading (line-oriented), wrong for re-publishing.
 */
export function cleanupAggressive(input: string): string {
  if (input.length === 0) return input
  // 1. Pre-fold unicode whitespace → ASCII space. NBSP-only lines become
  //    space-only lines, which step 2's rstrip turns into empty lines.
  const folded = foldUnicodeWhitespace(input)
  // 2. Run basic (rstrip + collapse 2+ blank runs + trim edges).
  const base = cleanupBasic(folded)
  // 3. Drop ALL single blank lines too. Done as a final pass so the basic
  //    transform's edge-trim still applies first.
  if (base.length === 0) return base
  const finalLines = base.split("\n").filter((l) => l.length > 0)
  return finalLines.join("\n")
}

/** Dispatch by level. Unknown levels return the input verbatim (defensive). */
export function applyCleanup(input: string, level: CleanupLevel): string {
  switch (level) {
    case "off":
      return input
    case "basic":
      return cleanupBasic(input)
    case "aggressive":
      return cleanupAggressive(input)
    default:
      return input
  }
}

/** True iff the given format should be cleaned (markdown / text only). */
export function isCleanableFormat(
  format: "markdown" | "text" | "html" | "links" | "accessibility" | "original",
): boolean {
  return format === "markdown" || format === "text"
}
