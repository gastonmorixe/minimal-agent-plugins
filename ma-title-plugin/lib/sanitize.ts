/**
 * Validate and sanitize a model title (SPEC §5.5).
 *
 * Pure functions, no IO. The system prompt asks for 2-6 words; the validator
 * accepts 1-8 words and 1-80 code points (SPEC §5.5 rule 4).
 *
 * @module lib/sanitize
 */

import { codePointLength, stripMaTags } from "./input.ts"

/** Max title length, in code points. */
export const TITLE_MAX_CHARS = 80
/** Min accepted number of words. */
export const TITLE_MIN_WORDS = 1
/** Max accepted number of words. */
export const TITLE_MAX_WORDS = 8

/** Pairs of outer quotes that sanitize removes. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
  ["\u00AB", "\u00BB"],
  ["\u300C", "\u300D"],
]

/** C0 and C1 control chars, DEL, and line or paragraph separators. */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/** Remove one pair of matching outer quotes, repeated while a pair is there. */
function stripOuterQuotes(text: string): string {
  let out = text
  for (let changed = true; changed; ) {
    changed = false
    for (const [open, close] of QUOTE_PAIRS) {
      if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim()
        changed = true
      }
    }
  }
  return out
}

/** Upper-case the first letter. The other letters do not change. */
function upperFirst(text: string): string {
  const first = text.codePointAt(0)
  if (first === undefined) return text
  const ch = String.fromCodePoint(first)
  return ch.toUpperCase() + text.slice(ch.length)
}

/**
 * Sanitize a raw title: remove `<ma::…>` tags, change control chars to a
 * space, collapse spaces, trim, remove outer quotes and one end period, and
 * make the first letter upper case. An ellipsis (`...`) at the end stays.
 */
export function sanitizeTitle(raw: string): string {
  let out = stripMaTags(raw).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim()
  out = stripOuterQuotes(out)
  if (out.endsWith(".") && !out.endsWith("..")) out = out.slice(0, -1).trimEnd()
  out = stripOuterQuotes(out)
  return upperFirst(out)
}

/** Number of words (white-space separated) in `text`. */
export function countWords(text: string): number {
  const t = text.trim()
  return t === "" ? 0 : t.split(/\s+/).length
}

/** True when a sanitized title has 1-8 words and 1-80 code points. */
export function isUsableTitle(title: string): boolean {
  const words = countWords(title)
  const chars = codePointLength(title)
  return (
    words >= TITLE_MIN_WORDS && words <= TITLE_MAX_WORDS && chars >= 1 && chars <= TITLE_MAX_CHARS
  )
}

/** Why a title result is a failure. */
export type TitleRejectReason = "stop-reason" | "not-string" | "unusable"

/** Result of {@link validateTitleResult}. */
export type TitleValidation =
  | { ok: true; title: string }
  | { ok: false; reason: TitleRejectReason; detail?: string }

/**
 * Validate one side-call result (SPEC §5.5 rules 1-5). `stopReason` must be
 * `end_turn`; `json.title` must be a string; the sanitized title must be
 * usable. Never throws.
 */
export function validateTitleResult(result: {
  stopReason?: string
  json?: unknown
}): TitleValidation {
  if (result.stopReason !== "end_turn") {
    return { ok: false, reason: "stop-reason", detail: String(result.stopReason) }
  }
  const json = result.json
  const raw =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>).title
      : undefined
  if (typeof raw !== "string") return { ok: false, reason: "not-string" }
  const title = sanitizeTitle(raw)
  if (!isUsableTitle(title)) return { ok: false, reason: "unusable", detail: title }
  return { ok: true, title }
}
