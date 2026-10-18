/**
 * Frontmatter tests: parse tolerance and serialize round-trip.
 */

import { describe, expect, it } from "bun:test"

import { parsePromptFile, serializePromptFile } from "../lib/frontmatter.ts"

describe("parsePromptFile", () => {
  it("parses name, description, and body", () => {
    const r = parsePromptFile("---\nname: x\ndescription: A thing\n---\nBODY\n")
    expect(r.front?.name).toBe("x")
    expect(r.front?.description).toBe("A thing")
    expect(r.body.trim()).toBe("BODY")
  })

  it("parses metadata", () => {
    const r = parsePromptFile("---\nname: x\ndescription: d\nmetadata:\n  team: core\n---\nb\n")
    expect(r.front?.metadata).toEqual({ team: "core" })
  })

  it("handles a quoted description", () => {
    const r = parsePromptFile('---\nname: x\ndescription: "has: colon"\n---\nb\n')
    expect(r.front?.description).toBe("has: colon")
  })

  it("handles a folded block scalar description", () => {
    const r = parsePromptFile("---\nname: x\ndescription: >\n  one\n  two\n---\nb\n")
    expect(r.front?.description).toBe("one two")
  })

  it("errors on missing frontmatter", () => {
    const r = parsePromptFile("just body")
    expect(r.front).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it("errors on an unterminated fence", () => {
    const r = parsePromptFile("---\nname: x\n")
    expect(r.front).toBeNull()
  })

  it("errors when name is missing", () => {
    const r = parsePromptFile("---\ndescription: d\n---\nb\n")
    expect(r.front).toBeNull()
    expect(r.errors.join(" ")).toContain("name")
  })

  it("tolerates a BOM", () => {
    const r = parsePromptFile("\uFEFF---\nname: x\ndescription: d\n---\nb\n")
    expect(r.front?.name).toBe("x")
  })
})

describe("serializePromptFile", () => {
  it("round-trips through parse", () => {
    const text = serializePromptFile({ name: "x", description: "d" }, "BODY\n")
    const r = parsePromptFile(text)
    expect(r.front?.name).toBe("x")
    expect(r.front?.description).toBe("d")
    expect(r.body.trim()).toBe("BODY")
  })

  it("quotes a description that needs it", () => {
    const text = serializePromptFile({ name: "x", description: "a: b" }, "b")
    expect(text).toContain('description: "a: b"')
  })
})
