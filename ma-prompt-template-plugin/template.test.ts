import { describe, expect, test } from "bun:test"

import { PromptTemplateError, renderTemplate } from "./template.ts"

describe("renderTemplate", () => {
  test("fills a required var and trims", () => {
    expect(renderTemplate("  a %%x%% b\n", { x: 1 })).toBe("a 1 b")
  })
  test("trim false keeps whitespace", () => {
    expect(renderTemplate(" %%x%% \n", { x: "v" }, { trim: false })).toBe(" v \n")
  })
  test("false and 0 are present, null and undefined are absent", () => {
    expect(renderTemplate("%%a%%|%%b%%", { a: false, b: 0 })).toBe("false|0")
    expect(() => renderTemplate("%%a%%", { a: null })).toThrow(PromptTemplateError)
    expect(renderTemplate("x%%a?%%y", { a: undefined })).toBe("xy")
  })
  test("one error lists every missing name once", () => {
    try {
      renderTemplate("%%a%% %%b%% %%a%%", {}, { source: "/p/f.md" })
      throw new Error("no throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PromptTemplateError)
      const err = e as PromptTemplateError
      expect(err.missing).toEqual(["a", "b"])
      expect(err.message).toBe("prompt template in /p/f.md is missing required variable(s): a, b")
    }
  })
  test("dropped optional collapses whole-line gaps", () => {
    expect(renderTemplate("a\n\n%%o?%%\n\nb", {})).toBe("a\n\nb")
    expect(renderTemplate("a  \n%%o?%%\nb", {})).toBe("a\n\nb")
  })
  test("no optional dropped keeps blank runs", () => {
    expect(renderTemplate("a\n\n\n\nb", {})).toBe("a\n\n\n\nb")
  })
})
