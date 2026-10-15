/**
 * Small JSONC reader: line comments, block comments, trailing commas.
 *
 * A single pass strips comments and trailing commas, then `JSON.parse` reads
 * plain JSON. Strings are copied with escape awareness, so comment markers
 * and commas inside strings stay. `parseJsonc` never throws.
 *
 * @module src/jsonc
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
      let j = i + 1
      while (j < n && input[j] !== '"') j += input[j] === "\\" ? 2 : 1
      out += input.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === "/" && next === "/") {
      while (i < n && input[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      const end = input.indexOf("*/", i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === ",") {
      let j = i + 1
      let probe = ""
      while (j < n) {
        const d = input[j]
        if (d === " " || d === "\t" || d === "\n" || d === "\r") {
          j++
        } else if (d === "/" && input[j + 1] === "/") {
          while (j < n && input[j] !== "\n") j++
        } else if (d === "/" && input[j + 1] === "*") {
          const end = input.indexOf("*/", j + 2)
          j = end === -1 ? n : end + 2
        } else {
          probe = d ?? ""
          break
        }
      }
      if (probe === "}" || probe === "]") {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/** Parse JSONC text. Returns `undefined` on any error. Never throws. */
export function parseJsonc(input: string): unknown {
  try {
    const text = stripJsonc(input)
    if (text.trim() === "") return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
