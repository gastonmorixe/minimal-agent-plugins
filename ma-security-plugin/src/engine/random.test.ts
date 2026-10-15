import { describe, expect, test } from "bun:test"

import { gen } from "../rules/gen.ts"

import { isRandomLooking, RANDOM_MIN_BITS, RANDOM_MIN_LEN } from "./random.ts"

describe("isRandomLooking (D9, D14)", () => {
  test("a 40-char random hex token passes (guards RANDOM_MIN_BITS = 3.0)", () => {
    expect(RANDOM_MIN_BITS).toBe(3.0)
    expect(isRandomLooking(gen({ len: 40, charset: "hex", seed: 11 }))).toBe(true)
  })

  test("a UUID-shaped key passes", () => {
    const h = gen({ len: 32, charset: "hex", seed: 12 })
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    expect(isRandomLooking(uuid)).toBe(true)
  })

  test("a long alnum token passes", () => {
    expect(isRandomLooking(gen({ len: 48, charset: "alnum", seed: 13 }))).toBe(true)
  })

  test("a 20-char value with 2 distinct chars fails (low entropy)", () => {
    expect(isRandomLooking("ab".repeat(10))).toBe(false)
  })

  test("a passphrase with spaces fails", () => {
    expect(isRandomLooking("correct horse battery staple jane")).toBe(false)
  })

  test("paths and URLs fail", () => {
    const hex = gen({ len: 40, charset: "hex", seed: 14 })
    expect(isRandomLooking(`/private/tmp/${hex}`)).toBe(false)
    expect(isRandomLooking(`~${hex}`)).toBe(false)
    expect(isRandomLooking(`https://${hex}`)).toBe(false)
  })

  test("values under the minimum length fail", () => {
    const hex = gen({ len: 40, charset: "hex", seed: 15 })
    expect(RANDOM_MIN_LEN).toBe(20)
    expect(isRandomLooking(hex.slice(0, 19))).toBe(false)
    expect(isRandomLooking(hex.slice(0, 20))).toBe(true)
  })

  test("non-string input fails and never throws", () => {
    expect(isRandomLooking(undefined as unknown as string)).toBe(false)
    expect(isRandomLooking(42 as unknown as string)).toBe(false)
  })
})
