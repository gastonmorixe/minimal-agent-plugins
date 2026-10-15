// Validators that run on captures only. Pure and sync.
import type { ValidatorName } from "../rules/types.ts"

/** Luhn check over the digits of `s`. Spaces and dashes are skipped. 12 to 19 digits. */
export function luhn(s: string): boolean {
  let sum = 0
  let n = 0
  let double = false
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i)
    if (c === 32 || c === 45) continue
    if (c < 48 || c > 57) return false
    let d = c - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    n++
    double = !double
  }
  return n >= 12 && n <= 19 && sum % 10 === 0
}

const B64URL = /^[A-Za-z0-9_-]+$/

function b64urlDecode(seg: string): string | null {
  if (!B64URL.test(seg)) return null
  try {
    return Buffer.from(seg, "base64url").toString("latin1")
  } catch {
    return null
  }
}

/**
 * JWT shape: three dot-separated base64url segments (signature may be empty only
 * when alg is "none"), header decodes to a JSON object with a string `alg`, payload
 * decodes to a JSON object.
 */
export function jwtShape(s: string): boolean {
  const parts = s.split(".")
  if (parts.length !== 3) return false
  const [h, p, sig] = parts as [string, string, string]
  if (h.length < 4 || p.length < 4) return false
  const hj = b64urlDecode(h)
  const pj = b64urlDecode(p)
  if (hj === null || pj === null) return false
  try {
    const header: unknown = JSON.parse(hj)
    const payload: unknown = JSON.parse(pj)
    if (typeof header !== "object" || header === null || Array.isArray(header)) return false
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false
    const alg = (header as Record<string, unknown>).alg
    if (typeof alg !== "string") return false
    if (sig.length === 0) return alg.toLowerCase() === "none"
    return B64URL.test(sig)
  } catch {
    return false
  }
}

/** Shannon entropy in bits per char over code units. 0 for an empty string. */
export function shannon(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<number, number>()
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export const VALIDATORS: Readonly<Record<ValidatorName, (s: string) => boolean>> = {
  luhn,
  "jwt-shape": jwtShape,
}
