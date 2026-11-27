import { describe, expect, test } from "bun:test"

import { GRANT_HINT, isSourceCheckout, missingHelperText } from "./missing-helper.ts"

describe("isSourceCheckout", () => {
  test("true when native/Sources exists", () => {
    const seen: string[] = []
    const exists = (p: string) => {
      seen.push(p)
      return true
    }
    expect(isSourceCheckout("/pkg", exists)).toBe(true)
    expect(seen).toEqual(["/pkg/native/Sources"])
  })

  test("false for an embedded package with no sources", () => {
    expect(isSourceCheckout("/cache/embedded/b1/ma-computer-use-plugin", () => false)).toBe(false)
  })
})

describe("missingHelperText", () => {
  test("dev checkout: build hint and grant hint", () => {
    const t = missingHelperText("/pkg/native/build/ComputerUseHelper", true)
    expect(t).toContain("bun run bin/cud.ts build")
    expect(t).toContain("/pkg/native/build/ComputerUseHelper")
    expect(t).toContain(GRANT_HINT)
  })

  test("compiled CLI: no build hint, no tool names, grant hint", () => {
    const t = missingHelperText("/cache/x/native/build/ComputerUseHelper", false)
    expect(t).toContain("does not include the computer-use helper")
    expect(t).toContain(GRANT_HINT)
    for (const word of ["bun", "cud.ts", "xcode", "swiftc", "git"]) {
      expect(t.toLowerCase()).not.toContain(word)
    }
  })
})
