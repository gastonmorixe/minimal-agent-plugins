/**
 * Rewrite tests: `&name` expansion on the model path.
 */

import { describe, expect, it } from "bun:test"

import { resolvePromptToken, rewritePrompts } from "../lib/rewrite.ts"
import type { Prompt } from "../lib/store.ts"

function p(slug: string, body: string): Prompt {
  return { slug, description: "", body, scope: "user", path: `/x/${slug}.md` }
}

const LIB = [p("review-pr", "REVIEW BODY"), p("release", "RELEASE BODY")]

describe("resolvePromptToken", () => {
  it("resolves an exact name", () => {
    expect(resolvePromptToken("release", LIB)?.slug).toBe("release")
  })

  it("resolves a unique prefix", () => {
    expect(resolvePromptToken("rel", LIB)?.slug).toBe("release")
  })

  it("returns null for an unknown token", () => {
    expect(resolvePromptToken("zzz", LIB)).toBeNull()
  })

  it("returns null for an empty token", () => {
    expect(resolvePromptToken("", LIB)).toBeNull()
  })
})

describe("rewritePrompts", () => {
  it("expands a token to the body", () => {
    expect(rewritePrompts("&release", LIB)).toBe("RELEASE BODY")
  })

  it("expands mid-message and keeps surroundings", () => {
    expect(rewritePrompts("please &release now", LIB)).toBe("please RELEASE BODY now")
  })

  it("expands multiple tokens", () => {
    expect(rewritePrompts("&release and &review-pr", LIB)).toBe("RELEASE BODY and REVIEW BODY")
  })

  it("leaves an unknown token untouched", () => {
    expect(rewritePrompts("&nope", LIB)).toBe("&nope")
  })

  it("does not touch a non-boundary ampersand", () => {
    expect(rewritePrompts("a&b", LIB)).toBe("a&b")
  })

  it("is a no-op with no ampersand", () => {
    expect(rewritePrompts("plain text", LIB)).toBe("plain text")
  })

  it("is idempotent on already-expanded text", () => {
    const once = rewritePrompts("&release", LIB)
    expect(rewritePrompts(once, LIB)).toBe(once)
  })

  it("is a no-op with an empty library", () => {
    expect(rewritePrompts("&release", [])).toBe("&release")
  })
})
