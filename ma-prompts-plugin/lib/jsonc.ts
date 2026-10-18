/**
 * Minimal JSONC parser.
 *
 * Strips line and block comments plus trailing commas, then `JSON.parse`.
 * Sufficient for a config file. String-aware so a `//` inside a quoted value
 * is preserved.
 *
 * @module lib/jsonc
 */

/**
 * Parse JSONC text into a value.
 *
 * @param text - The raw file contents, comments and trailing commas allowed.
 * @returns The parsed value.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}

/** Remove comments and trailing commas, preserving string contents. */
export function stripJsonc(text: string): string {
  let out = ""
  let i = 0
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false
        out += ch
      }
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") {
        // Copy the escaped char verbatim.
        if (next !== undefined) {
          out += next
          i += 2
          continue
        }
      }
      if (ch === '"') inString = false
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      inLineComment = true
      i += 2
      continue
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true
      i += 2
      continue
    }
    out += ch
    i++
  }

  // Drop trailing commas: `,` followed by optional whitespace then `}` or `]`.
  return out.replace(/,(\s*[}\]])/g, "$1")
}
