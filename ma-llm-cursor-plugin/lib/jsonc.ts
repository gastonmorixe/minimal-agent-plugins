// source: plugin-api/src/utils/jsonc.ts (vendored for E2E auth.jsonc reads)
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

/** Parse JSONC text. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}
