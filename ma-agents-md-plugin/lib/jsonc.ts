/**
 * Minimal JSONC (JSON with Comments) parser. Vendored from minimal-agent's
 * `src/jsonc.ts` so this plugin stays standalone.
 *
 * Supports:
 *   - Line comments:  `// ...` to end of line
 *   - Block comments: `/* ... *\/`
 *   - Trailing commas in objects and arrays
 *
 * Single-pass character scanner that strips comments + trailing commas,
 * then defers to `JSON.parse`. String escapes are respected so `"//"`
 * inside a value is preserved verbatim.
 *
 * @module lib/jsonc
 */

/** Strip JSONC comments and trailing commas. Returns plain JSON text. */
export function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  const n = input.length

  // Trailing-comma elision is done INLINE here, never via a post-pass regex.
  // A global `/,(\s*[}\]])/` over the stripped text would also rewrite a `,}`
  // or `,]` that appears INSIDE a string value, silently corrupting config.
  // Instead we defer emitting a structural comma until we see what follows:
  // a `}` / `]` means it was trailing (drop it); anything else flushes it.
  let pendingComma = false
  // Whitespace / comment filler seen since the deferred comma, replayed
  // verbatim whether the comma is later dropped or flushed (preserves layout).
  let gap = ""
  const flushComma = (): void => {
    if (pendingComma) {
      out += ","
      pendingComma = false
    }
    out += gap
    gap = ""
  }

  while (i < n) {
    const c = input[i]
    const next = input[i + 1]

    // String literal: copy verbatim, respecting escapes. A string is a value,
    // so a deferred comma before it was a real separator — flush it first.
    if (c === '"') {
      flushComma()
      const start = i
      i++
      while (i < n) {
        const ch = input[i]
        if (ch === "\\") {
          i += 2
          continue
        }
        if (ch === '"') {
          i++
          break
        }
        i++
      }
      out += input.slice(start, i)
      continue
    }

    // Line comment: skip to (not including) the newline.
    if (c === "/" && next === "/") {
      i += 2
      while (i < n && input[i] !== "\n") i++
      continue
    }

    // Block comment: skip to `*/`, emit a single space so adjoining tokens
    // don't fuse. The space is filler when a comma is pending.
    if (c === "/" && next === "*") {
      i += 2
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      if (pendingComma) gap += " "
      else out += " "
      continue
    }

    // Structural comma: defer (it might be trailing). A second comma flushes
    // the first so a malformed `,,` is preserved rather than swallowed.
    if (c === ",") {
      flushComma()
      pendingComma = true
      i++
      continue
    }

    // Closing bracket: a deferred comma before it was trailing — drop it,
    // but keep the intervening filler.
    if (c === "}" || c === "]") {
      pendingComma = false
      out += gap
      gap = ""
      out += c
      i++
      continue
    }

    // Whitespace: filler when a comma is pending, else copy through.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (pendingComma) gap += c
      else out += c
      i++
      continue
    }

    // Any other significant char (value, `{`, `[`, `:`): the deferred comma
    // was a real separator — flush it, then emit.
    flushComma()
    out += c
    i++
  }

  // A comma still pending at EOF is a top-level trailing comma (invalid JSON
  // regardless); flush it so `JSON.parse` reports faithfully.
  flushComma()
  return out
}

/** Parse JSONC text. Throws on invalid JSON after stripping. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}
