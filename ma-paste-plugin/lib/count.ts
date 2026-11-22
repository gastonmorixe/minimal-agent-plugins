/**
 * Byte and line counts of a paste (PLAN section 6).
 *
 * @module lib/count
 */

const ENCODER = new TextEncoder()

/** The UTF-8 byte length of `text`. */
export function utf8Bytes(text: string): number {
  return ENCODER.encode(text).length
}

/**
 * The line count of `text`: the LF count, plus 1 when the text is not empty
 * and does not end with LF. Empty text gives 0.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let n = 0
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++
  return text.endsWith("\n") ? n : n + 1
}

/** Change CRLF and CR to LF. No other change (B-5). */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}
