/**
 * Character tables and small scanners shared by the parser (design H, section 4).
 * No regex. Every function is a plain `charCodeAt` loop.
 */

/** Blank: space or tab. */
export const C_BLANK = 1
/** Shell metachar that ends a word: `& | ; ( ) < >` and newline. */
export const C_META = 2
/** Identifier start: letter or underscore. */
export const C_NAME0 = 4
/** Identifier char: letter, digit, underscore. */
export const C_NAME = 8
/** Decimal digit. */
export const C_DIGIT = 16

export const CLASS = new Uint8Array(128)
for (const ch of " \t") CLASS[ch.charCodeAt(0)] |= C_BLANK
for (const ch of "&|;()<>\n") CLASS[ch.charCodeAt(0)] |= C_META
for (let c = 65; c <= 90; c++) CLASS[c] |= C_NAME0 | C_NAME
for (let c = 97; c <= 122; c++) CLASS[c] |= C_NAME0 | C_NAME
CLASS[95] |= C_NAME0 | C_NAME
for (let c = 48; c <= 57; c++) CLASS[c] |= C_NAME | C_DIGIT

/** Class bits of char code `c` (0 for non-ASCII). */
export function cls(c: number): number {
  return c < 128 ? (CLASS[c] ?? 0) : 0
}

/** True when `c` ends an unquoted word (blank, metachar). NaN (EOF) also ends it. */
export function isWordEnd(c: number): boolean {
  if (Number.isNaN(c)) return true
  return (cls(c) & (C_BLANK | C_META)) !== 0
}

/** Letter or underscore. */
export function isNameStart(c: number): boolean {
  return (cls(c) & C_NAME0) !== 0
}

/** Letter, digit, or underscore. */
export function isNameChar(c: number): boolean {
  return (cls(c) & C_NAME) !== 0
}

/** Decimal digit. */
export function isDigit(c: number): boolean {
  return (cls(c) & C_DIGIT) !== 0
}

/** Read the longest operator at `pos`. Returns "" when no operator starts there. */
export function readOperator(src: string, pos: number): string {
  const c = src.charCodeAt(pos)
  const n = src.charCodeAt(pos + 1)
  const n2 = src.charCodeAt(pos + 2)
  switch (c) {
    case 10:
      return "\n"
    case 38: // &
      if (n === 38) return "&&"
      if (n === 62) return n2 === 62 ? "&>>" : "&>"
      return "&"
    case 124: // |
      if (n === 124) return "||"
      if (n === 38) return "|&"
      return "|"
    case 59: // ;
      if (n === 59) return n2 === 38 ? ";;&" : ";;"
      if (n === 38) return ";&"
      return ";"
    case 40:
      return "("
    case 41:
      return ")"
    case 60: // <
      if (n === 60) {
        if (n2 === 60) return "<<<"
        if (n2 === 45) return "<<-"
        return "<<"
      }
      if (n === 38) return "<&"
      if (n === 62) return "<>"
      return "<"
    case 62: // >
      if (n === 62) return ">>"
      if (n === 38) return ">&"
      if (n === 124) return ">|"
      return ">"
    default:
      return ""
  }
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

function codePoint(v: number, fallback: string): string {
  return v >= 0 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)
    ? String.fromCodePoint(v)
    : fallback
}

/**
 * Decode the body of a `$'...'` string (without the quotes).
 * Handles `\n \t \r \a \b \e \E \f \v \\ \' \" \? \xHH \NNN \uHHHH \UHHHHHHHH \cX`.
 */
export function decodeAnsiC(body: string): string {
  const out: string[] = []
  let i = 0
  let lit = 0
  const n = body.length
  while (i < n) {
    if (body.charCodeAt(i) !== 92 || i + 1 >= n) {
      i++
      continue
    }
    if (lit < i) out.push(body.slice(lit, i))
    const e = body[i + 1] ?? ""
    let j = i + 2
    switch (e) {
      case "n":
        out.push("\n")
        break
      case "t":
        out.push("\t")
        break
      case "r":
        out.push("\r")
        break
      case "a":
        out.push("\x07")
        break
      case "b":
        out.push("\b")
        break
      case "e":
      case "E":
        out.push("\x1b")
        break
      case "f":
        out.push("\f")
        break
      case "v":
        out.push("\v")
        break
      case "\\":
      case "'":
      case '"':
      case "?":
        out.push(e)
        break
      case "x":
      case "u":
      case "U": {
        const max = e === "x" ? 2 : e === "u" ? 4 : 8
        let v = 0
        let k = 0
        while (k < max && j < n) {
          const h = hexVal(body.charCodeAt(j))
          if (h < 0) break
          v = v * 16 + h
          j++
          k++
        }
        out.push(k === 0 ? `\\${e}` : codePoint(v, body.slice(i, j)))
        break
      }
      case "c": {
        const x = body.charCodeAt(j)
        if (Number.isNaN(x)) {
          out.push("\\c")
        } else {
          out.push(String.fromCharCode(x & 0x1f))
          j++
        }
        break
      }
      default: {
        const d = body.charCodeAt(i + 1)
        if (d >= 48 && d <= 55) {
          let v = 0
          let k = 0
          j = i + 1
          while (k < 3 && j < n) {
            const o = body.charCodeAt(j)
            if (o < 48 || o > 55) break
            v = v * 8 + (o - 48)
            j++
            k++
          }
          out.push(String.fromCharCode(v & 0xff))
        } else {
          out.push(body.slice(i, i + 2))
        }
      }
    }
    i = j
    lit = j
  }
  if (lit < n) out.push(body.slice(lit))
  return out.join("")
}

/** Remove NUL bytes, as bash does when it reads a script or stdin (review M8). */
export function stripNul(s: string): string {
  return s.indexOf("\0") < 0 ? s : s.split("\0").join("")
}

/** Last path segment: `/bin/rm` gives `rm`. */
export function basename(p: string): string {
  let end = p.length
  while (end > 1 && p.charCodeAt(end - 1) === 47) end--
  const i = p.lastIndexOf("/", end - 1)
  return i < 0 ? p.slice(0, end) : p.slice(i + 1, end)
}
