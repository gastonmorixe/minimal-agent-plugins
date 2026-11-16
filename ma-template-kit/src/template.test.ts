import { describe, expect, test } from "bun:test"

import { PromptTemplateError, renderLazy, renderTemplate, scanPlaceholders } from "./index.ts"

describe("renderTemplate", () => {
  test("fills required and dotted names", () => {
    expect(renderTemplate("%%sid.short%% · %%model%%", { "sid.short": "ab", model: "m" })).toBe(
      "ab · m",
    )
  })

  test("throws with every missing required name", () => {
    let err: unknown
    try {
      renderTemplate("%%a%% %%b%% %%a%%")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PromptTemplateError)
    expect((err as PromptTemplateError).missing.sort()).toEqual(["a", "b"])
  })

  test("optional empties and collapses a line-only slot", () => {
    expect(renderTemplate("A\n\n%%x?%%\n\nB", {})).toBe("A\n\nB")
  })

  test("trim false keeps surrounding whitespace", () => {
    expect(renderTemplate("  %%a%%\n", { a: 1 }, { trim: false })).toBe("  1\n")
  })
})

describe("scanPlaceholders", () => {
  test("first-use order, one per name, required wins", () => {
    expect(scanPlaceholders("%%b?%% %%a%% %%b%% %%c?%%")).toEqual([
      { name: "b", optional: false },
      { name: "a", optional: false },
      { name: "c", optional: true },
    ])
  })
})

describe("renderLazy", () => {
  test("computes only used names, once", () => {
    let calls = 0
    const out = renderLazy("%%a%%-%%a%%", {
      a: () => {
        calls++
        return "x"
      },
      unused: () => {
        throw new Error("must not run")
      },
    })
    expect(out).toBe("x-x")
    expect(calls).toBe(1)
  })

  test("a throwing getter counts as absent", () => {
    const boom = () => {
      throw new Error("no git")
    }
    expect(renderLazy("[%%b?%%]", { b: boom })).toBe("[]")
    expect(() => renderLazy("%%b%%", { b: boom })).toThrow(PromptTemplateError)
  })

  test("an unknown name is missing", () => {
    expect(() => renderLazy("%%nope%%", {})).toThrow(PromptTemplateError)
  })
})
