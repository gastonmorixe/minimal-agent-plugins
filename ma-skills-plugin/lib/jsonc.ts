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

  while (i < n) {
    const c = input[i]
    const next = input[i + 1]

    if (c === '"') {
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

    if (c === "/" && next === "/") {
      i += 2
      while (i < n && input[i] !== "\n") i++
      continue
    }

    if (c === "/" && next === "*") {
      i += 2
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      out += " "
      continue
    }

    out += c
    i++
  }

  out = out.replace(/,(\s*[}\]])/g, "$1")
  return out
}

/** Parse JSONC text. Throws on invalid JSON after stripping. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}
