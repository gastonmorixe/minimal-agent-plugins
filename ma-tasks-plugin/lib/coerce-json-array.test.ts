import { describe, expect, test } from "bun:test"

import { coerceJsonArray } from "./coerce-json-array.ts"

describe("coerceJsonArray", () => {
  test("passes through real arrays", () => {
    const r = coerceJsonArray(["a", "b"], "titles")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.coerced).toBe(false)
    expect(r.value).toEqual(["a", "b"])
  })

  test("parses stringified JSON arrays (items smoking gun)", () => {
    const raw = '[{"title":"Phase 1","children":["a","b"]},{"title":"Phase 2"}]'
    const r = coerceJsonArray(raw, "items")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.coerced).toBe(true)
    expect(r.value).toHaveLength(2)
    expect((r.value[0] as { title: string }).title).toBe("Phase 1")
  })

  test("rejects non-array JSON strings with a clear error", () => {
    const r = coerceJsonArray('{"title":"x"}', "items")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/stringified non-array|parsed to object/)
  })

  test("rejects unparseable strings", () => {
    const r = coerceJsonArray("[not-json", "titles")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/JSON\.parse failed/)
  })

  test("rejects empty string", () => {
    const r = coerceJsonArray("   ", "titles")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/empty string/)
  })

  test("rejects numbers / null", () => {
    expect(coerceJsonArray(1, "order").ok).toBe(false)
    expect(coerceJsonArray(null, "order").ok).toBe(false)
  })
})
