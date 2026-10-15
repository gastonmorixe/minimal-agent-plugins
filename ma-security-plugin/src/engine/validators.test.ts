import { describe, expect, it } from "bun:test"

import { jwtShape, luhn, shannon } from "./validators.ts"

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")

describe("luhn", () => {
  it("accepts valid test numbers and rejects near misses", () => {
    expect(luhn("4242424242424242")).toBe(true)
    expect(luhn("4242 4242 4242 4242")).toBe(true)
    expect(luhn("4242424242424241")).toBe(false)
    expect(luhn("42424242")).toBe(false)
    expect(luhn("4242a24242424242")).toBe(false)
  })
})

describe("jwtShape", () => {
  const h = b64({ alg: "HS256", typ: "JWT" })
  const p = b64({ sub: "fake-user" })
  it("accepts a well formed synthetic token", () => {
    expect(jwtShape(`${h}.${p}.c2lnbmF0dXJl`)).toBe(true)
  })
  it("rejects bad shapes", () => {
    expect(jwtShape(`${h}.${p}`)).toBe(false)
    expect(jwtShape(`${h}.${p}.`)).toBe(false)
    expect(jwtShape(`${b64({ typ: "JWT" })}.${p}.c2ln`)).toBe(false)
    expect(jwtShape(`${b64([1])}.${p}.c2ln`)).toBe(false)
    expect(jwtShape(`${h}.!!!!.c2ln`)).toBe(false)
    expect(jwtShape(`${h}.${p}.a+b`)).toBe(false)
  })
  it("allows an empty signature only for alg none", () => {
    expect(jwtShape(`${b64({ alg: "none" })}.${p}.`)).toBe(true)
  })
})

describe("shannon", () => {
  it("computes bits per char", () => {
    expect(shannon("")).toBe(0)
    expect(shannon("aaaa")).toBe(0)
    expect(shannon("abab")).toBeCloseTo(1, 6)
    expect(shannon("0123456789abcdef")).toBeCloseTo(4, 6)
  })
})
