/**
 * Title input: clean, cap and wrap the first user prompt (SPEC §5.4).
 *
 * Pure functions, no IO. Lengths are counted in Unicode code points, so a cut
 * never splits a surrogate pair (astral CJK, emoji).
 *
 * @module lib/input
 */

/** Above this length (code points) the cap applies. */
export const INPUT_MAX_CHARS = 2000
/** Code points kept from the start of a long text. */
export const INPUT_HEAD_CHARS = 1500
/** Code points kept from the end of a long text. */
export const INPUT_TAIL_CHARS = 400

/** A paired tag `<ma::x …>…</ma::x>`, with its content. */
const MA_PAIRED_TAG_RE = /<ma::([\w.:-]+)\b[^>]*>[\s\S]*?<\/ma::\1\s*>/g
/** A self-closing tag, or an open or close tag with no pair. */
const MA_SINGLE_TAG_RE = /<\/?ma::[^>]*>/g
/** Three or more line breaks, with only white space between them. */
const BLANK_RUN_RE = /\n[ \t]*(?:\n[ \t]*)+\n/g
/**
 * A literal session tag in user text, in all forms: any case, spaces around
 * the slash or the name, and attributes (`</session >`, `< /session>`,
 * `<session foo>`). `<sessions>` is a different word and stays.
 */
const SESSION_TAG_RE = /<\s*(\/?)\s*session\b[^>]*>/gi

/** Number of Unicode code points in `text`. */
export function codePointLength(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** Remove each `<ma::…>` tag. A paired tag is removed with its content. */
export function stripMaTags(text: string): string {
  return text.replace(MA_PAIRED_TAG_RE, "").replace(MA_SINGLE_TAG_RE, "")
}

/** True when `text` has at least one `<ma::` tag. */
export function hasMaTag(text: string): boolean {
  return text.includes("<ma::")
}

/**
 * Clean a prompt text: remove `<ma::…>` tags, change CRLF to LF, collapse
 * runs of blank lines to one blank line, trim.
 */
export function cleanPromptText(text: string): string {
  return stripMaTags(text.replace(/\r\n?/g, "\n")).replace(BLANK_RUN_RE, "\n\n").trim()
}

/**
 * Cap a text. A text of {@link INPUT_MAX_CHARS} code points or fewer does not
 * change. A longer text keeps the first {@link INPUT_HEAD_CHARS} code points,
 * a marker with the number of omitted code points, and the last
 * {@link INPUT_TAIL_CHARS} code points.
 */
export function capInput(text: string): string {
  const points = Array.from(text)
  if (points.length <= INPUT_MAX_CHARS) return text
  const omitted = points.length - INPUT_HEAD_CHARS - INPUT_TAIL_CHARS
  const head = points.slice(0, INPUT_HEAD_CHARS).join("")
  const tail = points.slice(points.length - INPUT_TAIL_CHARS).join("")
  return `${head}\n[… ${omitted} characters omitted …]\n${tail}`
}

/**
 * Wrap a text in the `<session>` data tags. A literal `<session>` or
 * `</session>` in the text is changed to `&lt;session>`, so the user text
 * cannot close the wrapper.
 */
export function wrapSession(text: string): string {
  const safe = text.replace(SESSION_TAG_RE, (tag) => `&lt;${tag.slice(1)}`)
  return `<session>\n${safe}\n</session>`
}

/** Full input pipeline: clean, cap, wrap. Use it for the title request. */
export function buildTitleInput(promptText: string): string {
  return wrapSession(capInput(cleanPromptText(promptText)))
}
