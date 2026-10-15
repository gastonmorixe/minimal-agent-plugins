/**
 * The one definition of "this value looks like a random secret" for the
 * security plugin (decisions D9 and D14). Config uses it to refuse random
 * looking `allow` values, and the known-value index uses it to pick substring
 * match mode for env and vault values. Pure and sync.
 *
 * @module src/engine/random
 */

import { shannon } from "./validators.ts"

/** Minimum length. Shorter values are guessable, so they stay whole-token. */
export const RANDOM_MIN_LEN = 20

/**
 * Minimum Shannon entropy in bits per char, over the value's own chars.
 * Random hex sits near 3.7 (max 4.0), so 3.0 keeps hex keys in. The pinned
 * test "a 40-char random hex token passes" in random.test.ts guards this
 * value: do not raise it without changing that test on purpose.
 */
export const RANDOM_MIN_BITS = 3.0

/**
 * True when ALL of these hold:
 * - length is RANDOM_MIN_LEN or more
 * - no whitespace (a passphrase stays whole-token)
 * - no leading `/` or `~` (paths such as SSH_AUTH_SOCK stay whole-token)
 * - no `://` (URLs stay whole-token)
 * - Shannon entropy is RANDOM_MIN_BITS or more bits per char
 *
 * @param value - The candidate value.
 * @returns True when the value looks like a random secret.
 */
export function isRandomLooking(value: string): boolean {
  if (typeof value !== "string") return false
  if (value.length < RANDOM_MIN_LEN) return false
  if (/\s/.test(value)) return false
  if (value.startsWith("/") || value.startsWith("~")) return false
  if (value.includes("://")) return false
  return shannon(value) >= RANDOM_MIN_BITS
}
