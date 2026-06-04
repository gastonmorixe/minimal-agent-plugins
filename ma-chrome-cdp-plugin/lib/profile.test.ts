import { describe, expect, test } from "bun:test"

import { candidateDtapPaths, PROFILE_SUBPATHS, resolveDtapPath } from "./profile.ts"

describe("candidateDtapPaths", () => {
  test("joins every known subpath under home and ends in DevToolsActivePort", () => {
    const paths = candidateDtapPaths("/Users/me")
    expect(paths.length).toBe(PROFILE_SUBPATHS.length)
    expect(paths[0]).toBe("/Users/me/Library/Application Support/Chromium/DevToolsActivePort")
    expect(paths.every((p) => p.endsWith("/DevToolsActivePort"))).toBe(true)
  })

  test("Chromium is preferred over Chrome (ordering)", () => {
    const paths = candidateDtapPaths("/h")
    const chromium = paths.findIndex((p) => p.includes("/Chromium/"))
    const chrome = paths.findIndex((p) => p.includes("/Google/Chrome/"))
    expect(chromium).toBeLessThan(chrome)
  })
})

describe("resolveDtapPath", () => {
  test("override wins unconditionally", () => {
    expect(resolveDtapPath({ home: "/h", override: "/custom/DTAP", exists: () => false })).toBe(
      "/custom/DTAP",
    )
  })

  test("returns first existing candidate", () => {
    const present = "/h/.config/google-chrome/DevToolsActivePort"
    const got = resolveDtapPath({ home: "/h", exists: (p) => p === present })
    expect(got).toBe(present)
  })

  test("throws a helpful error when nothing exists", () => {
    expect(() => resolveDtapPath({ home: "/h", exists: () => false })).toThrow(/CDP_DTAP/)
  })
})
