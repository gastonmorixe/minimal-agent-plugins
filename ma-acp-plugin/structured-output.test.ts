/**
 * Unit tests for `structured-output.ts`: the JSON Schema subset validator,
 * text parsing, and the retry decision (contract 5.e).
 *
 * @module structured-output.test
 */

import { describe, expect, it } from "bun:test"

import {
  checkStructuredOutput,
  decideStructuredStep,
  STRUCTURED_OUTPUT_MAX_RETRIES,
  validateJson,
} from "./structured-output.ts"

describe("validateJson (subset)", () => {
  it("checks type, including integer, number, null, and type arrays", () => {
    expect(validateJson(1, { type: "integer" })).toBeUndefined()
    expect(validateJson(1.5, { type: "integer" })).toContain("expected integer, got number")
    expect(validateJson(1, { type: "number" })).toBeUndefined()
    expect(validateJson(null, { type: ["string", "null"] })).toBeUndefined()
    expect(validateJson(true, { type: ["string", "null"] })).toContain("expected string or null")
    expect(validateJson([], { type: "object" })).toContain("got array")
  })

  it("checks required, properties, additionalProperties false, with a path", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "string" } } } },
      required: ["a"],
      additionalProperties: false,
    }
    expect(validateJson({ a: { b: "x" } }, schema)).toBeUndefined()
    expect(validateJson({}, schema)).toBe('$: missing required property "a"')
    expect(validateJson({ a: { b: 1 } }, schema)).toBe("$.a.b: expected string, got integer")
    expect(validateJson({ a: {}, z: 1 }, schema)).toBe('$: property "z" is not allowed')
  })

  it("checks items, enum, and const", () => {
    expect(validateJson([1, 2], { type: "array", items: { type: "integer" } })).toBeUndefined()
    expect(validateJson([1, "x"], { items: { type: "integer" } })).toBe(
      "$[1]: expected integer, got string",
    )
    expect(validateJson("b", { enum: ["a", "b"] })).toBeUndefined()
    expect(validateJson("c", { enum: ["a", "b"] })).toContain("one of")
    expect(validateJson({ k: [1] }, { const: { k: [1] } })).toBeUndefined()
    expect(validateJson(2, { const: 1 })).toContain("must be 1")
  })

  it("ignores unknown keywords, and handles boolean schemas", () => {
    expect(validateJson("x", { type: "string", pattern: "^y$", minLength: 5 })).toBeUndefined()
    expect(validateJson(1, true)).toBeUndefined()
    expect(validateJson(1, false)).toContain("no value")
  })
})

describe("validateJson limits", () => {
  const nest = (n: number) => {
    let schema: Record<string, unknown> = { const: { x: 1 } }
    let value: unknown = { x: 1 }
    let constVal: unknown = 1
    for (let i = 0; i < n; i++) {
      schema = { type: "object", properties: { a: schema }, required: ["a"] }
      value = { a: value }
      constVal = [constVal]
    }
    return { schema, value, constVal }
  }
  it("depth 1000 returns an error, no throw", () => {
    const { schema, value } = nest(1000)
    expect(() => validateJson(value, schema)).not.toThrow()
    expect(validateJson(value, schema)).toContain("deeper than 64 levels")
    const r = checkStructuredOutput(JSON.stringify(value), schema)
    expect(r.ok).toBe(false)
  })
  it("a deep const or enum value is not equal, no throw", () => {
    const { constVal } = nest(1000)
    // A structural copy, so `===` does not short-cut the walk.
    const copy = JSON.parse(JSON.stringify(constVal))
    expect(() => validateJson(copy, { const: constVal })).not.toThrow()
    expect(validateJson(copy, { enum: [constVal] })).toContain("must be one of")
  })
  it("shallow nesting still validates", () => {
    const { schema, value } = nest(10)
    expect(validateJson(value, schema)).toBeUndefined()
  })
  it("required and additionalProperties read own keys only", () => {
    expect(validateJson({}, { required: ["toString"] })).toContain(
      'missing required property "toString"',
    )
    expect(
      validateJson(JSON.parse('{"constructor": 1}'), {
        properties: {},
        additionalProperties: false,
      }),
    ).toContain('property "constructor" is not allowed')
  })
})

describe("checkStructuredOutput", () => {
  const schema = { type: "object", required: ["n"] }
  it("parses plain JSON and a fenced block", () => {
    expect(checkStructuredOutput(' {"n": 1} ', schema)).toEqual({ ok: true, value: { n: 1 } })
    expect(checkStructuredOutput('```json\n{"n": 2}\n```', schema)).toEqual({
      ok: true,
      value: { n: 2 },
    })
  })
  it("reports empty text, bad JSON, and a schema miss", () => {
    const empty = checkStructuredOutput("  ", schema)
    expect(empty.ok).toBe(false)
    const bad = checkStructuredOutput("hello", schema)
    expect(!bad.ok && bad.message).toContain("not valid JSON")
    const miss = checkStructuredOutput("{}", schema)
    expect(!miss.ok && miss.message).toContain('missing required property "n"')
  })
})

describe("decideStructuredStep", () => {
  const bad = { ok: false as const, message: "the reply is not valid JSON (x)" }
  it("is done with output on a valid check", () => {
    expect(
      decideStructuredStep({ check: { ok: true, value: 7 }, retriesUsed: 0, outcome: "completed" }),
    ).toEqual({ kind: "done", meta: { "minimal-agent/output": 7 } })
  })
  it("retries up to the default 2 times, with the error in the prompt", () => {
    expect(STRUCTURED_OUTPUT_MAX_RETRIES).toBe(2)
    for (const retriesUsed of [0, 1]) {
      const step = decideStructuredStep({ check: bad, retriesUsed, outcome: "completed" })
      expect(step.kind).toBe("retry")
      expect(step.kind === "retry" && step.prompt).toContain("not valid JSON (x)")
    }
    expect(decideStructuredStep({ check: bad, retriesUsed: 2, outcome: "completed" })).toEqual({
      kind: "done",
      meta: { "minimal-agent/outputError": { message: `${bad.message} (after 3 attempts)` } },
    })
  })
  it("does not retry a turn that did not complete", () => {
    for (const outcome of ["aborted", "truncated", "waiting"]) {
      const step = decideStructuredStep({ check: bad, retriesUsed: 0, outcome })
      expect(step.kind).toBe("done")
    }
  })
  it("honors a custom maxRetries", () => {
    expect(
      decideStructuredStep({ check: bad, retriesUsed: 0, maxRetries: 0, outcome: "completed" })
        .kind,
    ).toBe("done")
  })
})
