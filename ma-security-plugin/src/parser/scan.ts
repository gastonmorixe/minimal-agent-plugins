/**
 * Shared scan helpers for the parser (design H, sections 4 and 5).
 * Plain `charCodeAt` loops. No regex.
 */

import type { FailReason, Item, ParseLimits, SimpleCommand } from "./ast.ts"
import { isWordEnd } from "./lexer.ts"

/** Internal failure. Caught once in `parseCommand`. */
export class ParseFail extends Error {
  constructor(
    readonly reason: FailReason,
    readonly detail: string,
    readonly at: number,
  ) {
    super(detail)
  }
}

export interface Ctx {
  lim: ParseLimits
  words: number
  depth: number
  maxDepth: number
  plain: boolean
  /** Simple commands started by the top parser, for the partial tree. */
  started: SimpleCommand[]
  /** Item list of the top script, filled live. */
  topItems: Item[] | null
  /** Static var tracking is off for the rest of the parse (trap, nameref). */
  noTrack: boolean
  /** Vars with a value-changing attribute (`declare -i/-u/-l/-c`): never static. */
  tainted: Set<string>
  /** The text names IFS somewhere: unquoted params are never resolved. */
  ifsAny: boolean
  /** Function names defined in the script. A call wipes the static env. */
  funcs: Set<string>
}

/** Blank: space or tab. */
export function isBlank(c: number): boolean {
  return c === 32 || c === 9
}

/** Operator char that ends a word (not a blank). EOF is not a metachar. */
export function isMetaChar(c: number): boolean {
  return !Number.isNaN(c) && !isBlank(c) && isWordEnd(c)
}

/** Skip a backtick body from `pos` (the opening backtick). Returns index of the closing one or -1. */
export function backtickEnd(s: string, pos: number, end: number): number {
  let i = pos + 1
  while (i < end) {
    const c = s.charCodeAt(i)
    if (c === 92) i += 2
    else if (c === 96) return i
    else i++
  }
  return -1
}

/**
 * Find the char that closes the bracket at `pos` (`(` or `{`). Quote aware,
 * nested `$(` / `${` aware, comment aware. Linear. Returns -1 when unbalanced.
 */
export function matchClose(s: string, pos: number, end: number, close: number): number {
  const stack: number[] = [close]
  let i = pos + 1
  while (i < end) {
    const c = s.charCodeAt(i)
    const top = stack[stack.length - 1] as number
    const n = s.charCodeAt(i + 1)
    if (top === 34) {
      if (c === 92) i += 2
      else if (c === 34) {
        stack.pop()
        i++
      } else if (c === 36 && n === 40) {
        stack.push(41)
        i += 2
      } else if (c === 36 && n === 123) {
        stack.push(125)
        i += 2
      } else if (c === 96) {
        const e = backtickEnd(s, i, end)
        if (e < 0) return -1
        i = e + 1
      } else i++
      continue
    }
    switch (c) {
      case 92:
        i += 2
        continue
      case 39: {
        const e = s.indexOf("'", i + 1)
        if (e < 0 || e >= end) return -1
        i = e + 1
        continue
      }
      case 34:
        stack.push(34)
        i++
        continue
      case 96: {
        const e = backtickEnd(s, i, end)
        if (e < 0) return -1
        i = e + 1
        continue
      }
      case 35: {
        const p = s.charCodeAt(i - 1)
        if (top === 41 && (isBlank(p) || p === 10 || p === 40 || p === 59)) {
          const nl = s.indexOf("\n", i)
          i = nl < 0 || nl >= end ? end : nl
          continue
        }
        break
      }
      case 36:
        if (n === 40) {
          stack.push(41)
          i += 2
          continue
        }
        if (n === 123) {
          stack.push(125)
          i += 2
          continue
        }
        break
      default:
        break
    }
    if (top === 41) {
      if (c === 40) stack.push(41)
      else if (c === 41) {
        stack.pop()
        if (stack.length === 0) return i
      }
    } else if (top === 125) {
      if (c === 123) stack.push(125)
      else if (c === 125) {
        stack.pop()
        if (stack.length === 0) return i
      }
    }
    i++
  }
  return -1
}

/** Undo the backslash escapes of a backtick body: backslash before backtick, backslash, or dollar. */
export function unescapeBacktick(body: string): string {
  if (body.indexOf("\\") < 0) return body
  const out: string[] = []
  let lit = 0
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) !== 92) continue
    const n = body.charCodeAt(i + 1)
    if (n === 96 || n === 92 || n === 36) {
      out.push(body.slice(lit, i))
      lit = i + 1
      i++
    }
  }
  out.push(body.slice(lit))
  return out.join("")
}

/** Arith operator chars: `+ - * / % = < > ! & | ^ ~ ? ,`. */
const ARITH_OPS = "+-*/%=<>!&|^~?,"

/**
 * True when `t` holds an arith operator. `((ls))` has none: it stays a nested
 * subshell, so a word that may be a command is still walked (safe side).
 */
export function hasArithOp(t: string): boolean {
  for (let i = 0; i < t.length; i++) if (ARITH_OPS.includes(t.charAt(i))) return true
  return false
}

/** UTF-8 byte length without allocating a buffer. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3
  }
  return n
}
