/**
 * Line numbers for the paste body that the model gets: `N<TAB>line`, from
 * 1. It is the same line form as the core Read tool, but a final LF gets no
 * number (the Read tool numbers the empty part after it).
 *
 * @module lib/number
 */

/**
 * Put a line number before each line of `text`. A final LF stays, with no
 * number after it, so the line count is the same as `countLines`. Empty
 * text stays empty.
 */
export function numberLines(text: string): string {
  if (text === "") return text
  const trailing = text.endsWith("\n")
  const lines = (trailing ? text.slice(0, -1) : text).split("\n")
  const body = lines.map((line, i) => `${i + 1}\t${line}`).join("\n")
  return trailing ? `${body}\n` : body
}
