import { describe, expect, it } from "bun:test"

import { isSafeSid, normalizePeerRef, shortId, sidMatchesRef } from "./identity.ts"

describe("isSafeSid — path-traversal guard", () => {
  it("accepts real uuids and short ids", () => {
    expect(isSafeSid("5637f8a0-cd79-45a2-a9b3-e0c0adcfa721")).toBe(true)
    expect(isSafeSid("abc123")).toBe(true)
  })

  it("rejects path-traversal and separators", () => {
    expect(isSafeSid("../../etc/passwd")).toBe(false)
    expect(isSafeSid("a/b")).toBe(false)
    expect(isSafeSid("a\\b")).toBe(false)
    expect(isSafeSid("..")).toBe(false)
    expect(isSafeSid("a.b")).toBe(false) // dot would allow `.` games
  })

  it("rejects empty, non-string, and over-long", () => {
    expect(isSafeSid("")).toBe(false)
    expect(isSafeSid(null)).toBe(false)
    expect(isSafeSid(123)).toBe(false)
    expect(isSafeSid("a".repeat(129))).toBe(false)
  })
})

describe("normalizePeerRef + sidMatchesRef", () => {
  it("strips a leading @ and lowercases", () => {
    expect(normalizePeerRef("@A1B2C3")).toBe("a1b2c3")
  })

  it("resolves a short id, a longer prefix, and the full sid (incremental matching)", () => {
    const full = "5637f8a0-cd79-45a2-a9b3-e0c0adcfa721"
    expect(sidMatchesRef(full, "5637f8a0")).toBe(true) // the 8-char display handle
    expect(sidMatchesRef(full, "5637")).toBe(true) // a shorter prefix
    expect(sidMatchesRef(full, full)).toBe(true) // the whole sid
    expect(sidMatchesRef(full, "ffffffff")).toBe(false) // no match
  })

  it("shortId renders the leading 8-char hex group (matches the footer)", () => {
    expect(shortId("bd94a4be-af3a-4bc5-a18c-993b26a86682")).toBe("bd94a4be")
  })
})
