import { describe, expect, it } from "bun:test"

import { gen } from "../rules/gen.ts"
import { isWholeTokenAt, TOKEN_CHAR_CLASS } from "../state/types.ts"

// Synthetic value. Not a real provider format.
const v = gen({ prefix: "zzq-", len: 24, charset: "alnum", seed: 41 })

/** Whole-token check of the first occurrence of v in text. */
function hit(text: string): boolean {
  const i = text.indexOf(v)
  if (i < 0) throw new Error("value not in text")
  return isWholeTokenAt(text, i, i + v.length)
}

describe("review2 MJ2 TOKEN_CHAR_CLASS boundary", () => {
  it("is [A-Za-z0-9_+/-] with no = . ~ %", () => {
    expect(TOKEN_CHAR_CLASS).toBe("[A-Za-z0-9_+/-]")
    const re = new RegExp(TOKEN_CHAR_CLASS)
    for (const c of ["=", ".", "~", "%", "&", "?", '"', " ", ":"]) expect(re.test(c)).toBe(false)
    for (const c of ["a", "Z", "0", "_", "+", "/", "-"]) expect(re.test(c)).toBe(true)
  })

  it("isWholeTokenAt agrees with the class for every ASCII char", () => {
    const re = new RegExp(TOKEN_CHAR_CLASS)
    for (let c = 0; c < 128; c++) {
      const ch = String.fromCharCode(c)
      expect(isWholeTokenAt(`${ch}ab`, 1, 3)).toBe(!re.test(ch))
      expect(isWholeTokenAt(`ab${ch}`, 0, 2)).toBe(!re.test(ch))
    }
  })

  it("matches KEY=v (env and .env dumps)", () => {
    expect(hit(`API_KEY=${v}`)).toBe(true)
    expect(hit(`API_KEY=${v}\nNEXT=1`)).toBe(true)
  })

  it("matches v. at sentence end, quoted v, and v in a URL query", () => {
    expect(hit(`the key is ${v}.`)).toBe(true)
    expect(hit(`"${v}"`)).toBe(true)
    expect(hit(`'${v}'`)).toBe(true)
    expect(hit(`https://h.example/x?a=${v}&b=2`)).toBe(true)
    expect(hit(`x%3D%22${v}%22`)).toBe(false)
    expect(hit(v)).toBe(true)
  })

  it("known limit: a value right after a %XX escape is not a whole token", () => {
    // The hex digits of %3D are token chars, so a char-class boundary cannot see the
    // escape. B6 must not rely on this boundary for double-encoded text.
    expect(hit(`x%3D${v}%26`)).toBe(false)
    expect(hit(`x=${v}&`)).toBe(true)
  })

  it("does not match path/v: / is a token char (base64 alphabet)", () => {
    // A base64 blob holds "/" and "+". Treating them as boundaries would match a known
    // value that is only a fragment of a longer base64 token. The base64 and URL forms
    // of each value are indexed on their own, so the split is not needed.
    expect(hit(`path/${v}`)).toBe(false)
    expect(hit(`${v}/rest`)).toBe(false)
    expect(hit(`a+${v}`)).toBe(false)
  })

  it("does not match v inside a longer token", () => {
    expect(hit(`x${v}`)).toBe(false)
    expect(hit(`${v}x`)).toBe(false)
    expect(hit(`_${v}_`)).toBe(false)
    expect(hit(`pre-${v}`)).toBe(false)
  })

  it("handles offsets at the text edges and bad ranges", () => {
    expect(isWholeTokenAt("ab", 0, 2)).toBe(true)
    expect(isWholeTokenAt("ab", 0, 1)).toBe(false)
    expect(isWholeTokenAt("ab", 1, 1)).toBe(false)
    expect(isWholeTokenAt("ab", -1, 2)).toBe(false)
    expect(isWholeTokenAt("ab", 0, 3)).toBe(false)
  })
})
