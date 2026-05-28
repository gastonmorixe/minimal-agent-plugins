import { describe, expect, it } from "bun:test"

import { actionsProvider, BUILTIN_ACTIONS } from "./actions.ts"

describe("actions provider", () => {
  it("returns the static list", () => {
    expect(actionsProvider.list()).toBe(BUILTIN_ACTIONS)
  })

  it("every entry has slug + description + category 'act'", () => {
    for (const item of BUILTIN_ACTIONS) {
      expect(item.slug.length).toBeGreaterThan(0)
      expect(item.description.length).toBeGreaterThan(0)
      expect(item.category).toBe("act")
      expect(item.payload).toBeDefined()
    }
  })

  it("slugs are unique", () => {
    const slugs = BUILTIN_ACTIONS.map((i) => i.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("slugs are kebab-case lowercase (no spaces, no slashes)", () => {
    for (const item of BUILTIN_ACTIONS) {
      expect(item.slug).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it("includes the canonical example commands the design references", () => {
    const slugs = new Set(BUILTIN_ACTIONS.map((i) => i.slug))
    for (const required of ["config", "context", "skills", "memory", "tasks", "help"]) {
      expect(slugs).toContain(required)
    }
  })
})
