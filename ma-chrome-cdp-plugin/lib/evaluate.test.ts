import { describe, expect, test } from "bun:test"

import { EVALUATE_PARAMS, extractEvalResult, isEvalError } from "./evaluate.ts"

describe("EVALUATE_PARAMS", () => {
  test("returns by value, awaits promises, marks a user gesture", () => {
    expect(EVALUATE_PARAMS).toEqual({ returnByValue: true, awaitPromise: true, userGesture: true })
  })
})

describe("extractEvalResult", () => {
  test("returns the primitive value", () => {
    expect(extractEvalResult({ result: { result: { value: 6 } } })).toBe(6)
  })

  test("returns a string value", () => {
    expect(extractEvalResult({ result: { result: { value: "Top Stories" } } })).toBe("Top Stories")
  })

  test("returns undefined when there is no value", () => {
    expect(extractEvalResult({ result: { result: {} } })).toBeUndefined()
  })

  test("maps a thrown exception to {__error} using description", () => {
    const v = extractEvalResult({
      result: {
        exceptionDetails: { exception: { description: "Error: boom\n at <anonymous>:1:7" } },
      },
    })
    expect(isEvalError(v)).toBe(true)
    if (isEvalError(v)) expect(v.__error).toContain("boom")
  })

  test("falls back to exceptionDetails.text when no description", () => {
    const v = extractEvalResult({ result: { exceptionDetails: { text: "Uncaught" } } })
    expect(isEvalError(v)).toBe(true)
    if (isEvalError(v)) expect(v.__error).toBe("Uncaught")
  })
})

describe("isEvalError", () => {
  test("true only for the __error shape", () => {
    expect(isEvalError({ __error: "x" })).toBe(true)
    expect(isEvalError({ value: 1 })).toBe(false)
    expect(isEvalError(null)).toBe(false)
    expect(isEvalError("err")).toBe(false)
  })
})
