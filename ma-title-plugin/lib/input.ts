/**
 * Title input: clean, cap and wrap the first user prompt, then add one
 * language line (SPEC §5.4).
 *
 * Pure functions, no IO. Lengths are counted in Unicode code points, so a cut
 * never splits a surrogate pair (astral CJK, emoji).
 *
 * @module lib/input
 */

import type { TitleSideband } from "./host-types.ts"
import { expandPasteRefs, type PasteSource } from "./paste.ts"

/** Above this length (code points) the cap applies. */
export const INPUT_MAX_CHARS = 2000
/** Code points kept from the start of a long text. */
export const INPUT_HEAD_CHARS = 1500
/** Code points kept from the end of a long text. */
export const INPUT_TAIL_CHARS = 400

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

/**
 * Remove each internal (sideband) tag with the session codec. A complete
 * node goes with its body. The lenient strip also removes broken tag parts
 * (a lone end part; a start part with no end part, with the rest of its line).
 * `keepBody` stays false: with it, the body of a policy tag goes to the model.
 */
export function stripMaTags(text: string, sb: TitleSideband): string {
  return sb.strip(text, { lenient: true })
}

/** True when `text` has at least one internal (sideband) node. */
export function hasMaTag(text: string, sb: TitleSideband): boolean {
  return sb.has(text)
}

/**
 * A saved prompt token (`&name`) at a word boundary. The same rule as
 * `TOKEN_RE` in `ma-prompts-plugin/lib/rewrite.ts`. Group 1 is the char
 * before the `&`. It has no `g` flag, so a `.test()` call keeps no state.
 * {@link removePromptTokens} adds the `g` flag.
 */
export const PROMPT_TOKEN_RE = /(^|[\s([{])&([a-zA-Z0-9_-]+)/

/**
 * Remove each saved prompt token (`&name`) and keep the char before it. A
 * token is a reference to a template of instructions that the user uses
 * again. It is not the subject of the session.
 */
export function removePromptTokens(text: string): string {
  return text.replace(new RegExp(PROMPT_TOKEN_RE.source, "g"), "$1")
}

/** Options of {@link cleanPromptText} and {@link buildTitleInput}. */
export interface CleanOptions {
  /**
   * Where to read the paste files. Without it, each self-closing paste ref
   * gives the marker `(pasted text)`.
   */
  source?: PasteSource
}

/**
 * Clean a prompt text. The steps, in this order: change CRLF to LF, remove
 * the saved prompt tokens (`&name`), put the text of each paste ref in place
 * of the ref, remove the other internal tags, collapse runs of blank lines to
 * one blank line, trim. The tokens go before the paste step, so an `&word`
 * in the pasted text stays.
 */
export function cleanPromptText(text: string, sb: TitleSideband, opts: CleanOptions = {}): string {
  const lf = text.replace(/\r\n?/g, "\n")
  const pasted = expandPasteRefs(removePromptTokens(lf), sb, opts.source)
  return stripMaTags(pasted, sb).replace(BLANK_RUN_RE, "\n\n").trim()
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

/** Max length (code points) of a language name. */
export const LANGUAGE_MAX_CHARS = 40
/** A language name: letters, spaces and hyphens only. */
const LANGUAGE_RE = /^[\p{L}\p{M}][\p{L}\p{M} -]*$/u

/**
 * Clean a language name: trim, max {@link LANGUAGE_MAX_CHARS} code points,
 * letters, spaces and hyphens only. A bad value gives `undefined`.
 */
export function sanitizeLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const v = value.trim()
  if (v === "" || codePointLength(v) > LANGUAGE_MAX_CHARS) return undefined
  return LANGUAGE_RE.test(v) ? v : undefined
}

/**
 * The default language line (same meaning as the Claude Code line): the
 * model uses the main language of the session text.
 */
export const DEFAULT_LANGUAGE_LINE =
  "Write the title in the main language of the text in <session>. One word or code name in another language does not change it. The language of these instructions does not change it."

/**
 * The language line after the `<session>` block. A set language gives a fixed
 * line for that language. Unset or bad gives {@link DEFAULT_LANGUAGE_LINE}.
 */
export function languageLine(language?: string): string {
  const lang = sanitizeLanguage(language)
  if (!lang) return DEFAULT_LANGUAGE_LINE
  return `Write the title in ${lang}. Keep technical terms and code names as they are.`
}

/**
 * Full input pipeline: clean, cap, wrap, then one language line. Use it for
 * the user message of the title request. The layout is the same as Claude
 * Code: `<session>\n{text}\n</session>\n\n{language line}`. The rules are in
 * the system prompt.
 */
export function buildTitleInput(
  promptText: string,
  sb: TitleSideband,
  language?: string,
  opts: CleanOptions = {},
): string {
  return wrapCleanText(cleanPromptText(promptText, sb, opts), language)
}

/**
 * Cap and wrap a text that is clean already, then add one language line.
 * The tool path uses it for a text that it joined from more than one message.
 */
export function wrapCleanText(cleanText: string, language?: string): string {
  return `${wrapSession(capInput(cleanText))}\n\n${languageLine(language)}`
}
