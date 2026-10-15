// Deterministic example generator. Same Gen, same string. No real values.
import type { Gen, GenCharset } from "./types.ts"

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

export const CHARSETS: Readonly<Record<GenCharset, string>> = {
  alnum: ALNUM,
  "alnum-_": `${ALNUM}-_`,
  hex: "0123456789abcdef",
  b64url: `${ALNUM}-_`,
  "upper-digit": "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
}

/** xorshift32 step. Seed 0 is mapped to a fixed non-zero state. */
export function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s
  }
}

/** Make `prefix + body(len chars of charset) + suffix`. */
export function gen(g: Gen): string {
  const chars = CHARSETS[g.charset]
  const next = xorshift32(g.seed)
  let body = ""
  for (let i = 0; i < g.len; i++) body += chars[next() % chars.length]
  return `${g.prefix ?? ""}${body}${g.suffix ?? ""}`
}

/** Expand an example text: every `{{S}}` becomes gen(secret). */
export function fillExample(text: string, secret: Gen): { text: string; secret: string } {
  const value = gen(secret)
  return { text: text.split("{{S}}").join(value), secret: value }
}
