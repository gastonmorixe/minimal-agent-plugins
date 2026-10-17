/**
 * Raw-text fallback view (design H, section 7).
 * One linear pass: drop `#` comments (word start, outside quotes), drop quote
 * characters and backslashes, split on blanks and shell operator characters.
 * Splitting also happens inside quotes, so `echo "rm -rf /"` gives `rm` as a
 * token. That is the documented trade-off: after a parse failure the display
 * exception does not apply.
 */

import type { RawScan } from "./ast.ts"

/** Max chars that a raw scan covers in full (SPEC change, M7). */
export const RAW_FULL_MAX = 4 * 1024 * 1024
/** Over `RAW_FULL_MAX`: chars scanned at the head and at the tail. */
export const RAW_HALF = 2 * 1024 * 1024

function isSep(c: number): boolean {
  switch (c) {
    case 32: // space
    case 9: // tab
    case 10: // newline
    case 13: // CR
    case 38: // &
    case 124: // |
    case 59: // ;
    case 40: // (
    case 41: // )
    case 60: // <
    case 62: // >
    case 96: // backtick
    case 36: // $
    case 123: // {
    case 125: // }
      return true
    default:
      return false
  }
}

/** Scan `text` for the fallback matcher. Never throws on string input. */
export function rawScan(text: string, truncated = false): RawScan {
  const tokens: string[] = []
  const kept: string[] = []
  const n = text.length
  let cur = ""
  let quote = 0
  let segStart = 0
  let prevSep = true
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (quote === 39) {
      if (c === 39) quote = 0
      else if (isSep(c)) {
        if (cur) tokens.push(cur)
        cur = ""
      } else cur += text.charAt(i)
      continue
    }
    if (c === 92) {
      if (i + 1 < n) cur += text.charAt(i + 1)
      i++
      prevSep = false
      continue
    }
    if (quote === 34) {
      if (c === 34) quote = 0
      else if (isSep(c)) {
        if (cur) tokens.push(cur)
        cur = ""
      } else cur += text.charAt(i)
      continue
    }
    if (c === 39 || c === 34) {
      quote = c
      prevSep = false
      continue
    }
    if (c === 35 && prevSep && cur === "") {
      if (segStart < i) kept.push(text.slice(segStart, i))
      const nl = text.indexOf("\n", i)
      i = nl < 0 ? n : nl - 1
      segStart = nl < 0 ? n : nl
      continue
    }
    if (isSep(c)) {
      if (cur) tokens.push(cur)
      cur = ""
      prevSep = true
      continue
    }
    cur += text.charAt(i)
    prevSep = false
  }
  if (cur) tokens.push(cur)
  if (segStart < n) kept.push(text.slice(segStart))
  return {
    stripped: kept.join(""),
    tokens,
    hasUnclosedQuote: quote !== 0,
    truncated,
    fullScan: true,
  }
}

/**
 * Scan an input that is over the parse limit (`truncated` is true).
 * Up to 4 MB the whole text is scanned (linear). Above 4 MB only the first
 * 2 MB and the last 2 MB are scanned, and `fullScan` is false.
 */
export function rawScanTruncated(text: string, _maxChars?: number): RawScan {
  if (text.length <= RAW_FULL_MAX) return rawScan(text, true)
  const head = text.slice(0, RAW_HALF)
  const tail = text.slice(text.length - RAW_HALF)
  const r = rawScan(`${head}\n${tail}`, true)
  r.fullScan = false
  return r
}
