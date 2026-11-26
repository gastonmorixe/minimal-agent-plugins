/**
 * Tests of the JSON-Schema to Gemini-subset sanitizer.
 *
 * @module schema-sanitize.test
 */

import { describe, expect, it } from "bun:test"

import { sanitizeGeminiSchema } from "./schema-sanitize.ts"

describe("sanitizeGeminiSchema", () => {
  it("upper-cases the type and keeps a declared object schema", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { Path: { type: "string", description: "File path." } },
      required: ["Path"],
    })
    expect(out).toEqual({
      type: "OBJECT",
      properties: { Path: { type: "STRING", description: "File path." } },
      required: ["Path"],
    })
  })

  it("drops keywords the backend rejects", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: { a: { type: "integer" } },
    })
    expect(out).not.toHaveProperty("$schema")
    expect(out).not.toHaveProperty("additionalProperties")
    expect(out).toHaveProperty("type", "OBJECT")
  })

  it("turns a nullable type array into nullable:true", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { note: { type: ["string", "null"] } },
    })
    expect(out).toEqual({
      type: "OBJECT",
      properties: { note: { type: "STRING", nullable: true } },
    })
  })

  it("drops a required entry that names no property", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    })
    expect(out).toHaveProperty("required", ["a"])
  })

  it("drops an empty required list", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["ghost"],
    })
    expect(out).not.toHaveProperty("required")
  })

  it("recurses into items and keeps enum", () => {
    const out = sanitizeGeminiSchema({
      type: "array",
      items: {
        type: "object",
        properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      },
    })
    expect(out).toEqual({
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { mode: { type: "STRING", enum: ["fast", "slow"] } },
      },
    })
  })

  it("keeps anyOf branches, each sanitized", () => {
    const out = sanitizeGeminiSchema({
      anyOf: [{ type: "string" }, { type: "number" }],
    })
    expect(out).toEqual({ anyOf: [{ type: "STRING" }, { type: "NUMBER" }] })
  })

  it("adds OBJECT when properties exist and no type is declared", () => {
    const out = sanitizeGeminiSchema({ properties: { a: { type: "string" } } })
    expect(out).toHaveProperty("type", "OBJECT")
  })

  it("returns an empty schema for a non-object input", () => {
    expect(sanitizeGeminiSchema(null)).toEqual({})
    expect(sanitizeGeminiSchema("string")).toEqual({})
    expect(sanitizeGeminiSchema([1, 2])).toEqual({})
  })

  it("never mutates the input", () => {
    const input = { type: "object", properties: { a: { type: "string" } }, oneOf: [] }
    const snapshot = JSON.stringify(input)
    sanitizeGeminiSchema(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it("drops oneOf at the root and keeps anyOf", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { v: { oneOf: [{ type: "string" }], anyOf: [{ type: "number" }] } },
    })
    const value = (out.properties as Record<string, Record<string, unknown>>).v
    expect(value).not.toHaveProperty("oneOf")
    expect(value).toHaveProperty("anyOf", [{ type: "NUMBER" }])
  })
})
