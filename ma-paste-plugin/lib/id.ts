/**
 * Paste ids: 5 chars from `[0-9a-z]` (36^5 = 60,466,176 values).
 *
 * @module lib/id
 */

/** The rule for a paste id. */
export const PASTE_ID_RE = /^[0-9a-z]{5}$/

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
const ID_LEN = 5
/** 252 = 7 * 36. A byte of 252 or more is rejected, so each char is uniform. */
const REJECT_AT = 252

/** Fills a byte array with random values. */
export type Rng = (bytes: Uint8Array) => Uint8Array

const cryptoRng: Rng = (bytes) => crypto.getRandomValues(bytes)

/** True when `id` is a valid paste id. */
export function isPasteId(id: unknown): id is string {
  return typeof id === "string" && PASTE_ID_RE.test(id)
}

/** A new random paste id. Rejection sampling: no modulo bias. */
export function newId(rng: Rng = cryptoRng): string {
  let out = ""
  const buf = new Uint8Array(16)
  while (out.length < ID_LEN) {
    rng(buf)
    for (const b of buf) {
      if (b >= REJECT_AT) continue
      out += ALPHABET[b % 36]
      if (out.length === ID_LEN) break
    }
  }
  return out
}
