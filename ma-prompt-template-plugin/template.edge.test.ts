import { describe, expect, test } from "bun:test"

import { PromptTemplateError, renderTemplate } from "./template.ts"

describe("single pass: values are never expanded again", () => {
  test("a value that holds a required placeholder stays literal", () => {
    const out = renderTemplate("x %%a%% y", { a: "%%secret%%", secret: "S" })
    expect(out).toBe("x %%secret%% y")
    expect(out).not.toContain("S ")
  })

  test("a value that holds an optional placeholder stays literal", () => {
    const out = renderTemplate("x %%a%% y", { a: "%%secret?%%", secret: "S" })
    expect(out).toBe("x %%secret?%% y")
  })

  test("a value that holds its own name does not loop", () => {
    expect(renderTemplate("%%a%%", { a: "%%a%%" })).toBe("%%a%%")
  })
})

describe("nested and adjacent percent signs", () => {
  test("%%a%%b%%%% replaces the first placeholder only", () => {
    expect(renderTemplate("%%a%%b%%%%", { a: "1", b: "2" })).toBe("1b%%%%")
  })

  test("%%%%a%%%% keeps the outer percent pairs", () => {
    expect(renderTemplate("%%%%a%%%%", { a: "1" })).toBe("%%1%%")
  })

  test("%%a%%%%b%% replaces two adjacent placeholders", () => {
    expect(renderTemplate("%%a%%%%b%%", { a: "1", b: "2" })).toBe("12")
  })
})

describe("characters outside the allowed set stay literal", () => {
  const cases = ["%%a b%%", "%%a/b%%", "%%%%", "%% %%", "%%a?b%%", "%%a??%%"]
  for (const input of cases) {
    test(`${JSON.stringify(input)} is not a placeholder`, () => {
      const vars = { a: "X", b: "Y", "a b": "Z", "a/b": "Z", "a?b": "Z" }
      expect(renderTemplate(input, vars, { trim: false })).toBe(input)
    })
  }
})

describe("no escape syntax for a literal placeholder", () => {
  test("a required placeholder with no value throws and lists the name", () => {
    let caught: unknown
    try {
      renderTemplate("show %%name%% in docs")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PromptTemplateError)
    expect((caught as PromptTemplateError).missing).toEqual(["name"])
    expect((caught as PromptTemplateError).message).toContain("name")
  })

  test("an optional placeholder with no value becomes an empty string", () => {
    expect(renderTemplate("show [%%name?%%] in docs")).toBe("show [] in docs")
  })
})
