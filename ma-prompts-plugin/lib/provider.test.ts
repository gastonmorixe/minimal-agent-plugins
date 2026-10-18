/**
 * Provider tests: prompt to menu item mapping.
 */

import { describe, expect, it } from "bun:test"

import { itemsFromLoad } from "../lib/provider.ts"
import type { LoadResult } from "../lib/store.ts"

describe("itemsFromLoad", () => {
  it("maps a prompt to an item with a body payload", () => {
    const result: LoadResult = {
      prompts: [
        { slug: "x", description: "a thing", body: "BODY", scope: "user", path: "/x/x.md" },
      ],
      broken: [],
    }
    const items = itemsFromLoad(result)
    expect(items.length).toBe(1)
    expect(items[0]!.slug).toBe("x")
    expect(items[0]!.category).toBe("prm")
    expect((items[0]!.payload as { body: string }).body).toBe("BODY")
  })

  it("marks a broken file as a disabled row", () => {
    const result: LoadResult = {
      prompts: [],
      broken: [{ slug: "bad", path: "/x/bad.md", scope: "user", errors: ["boom"] }],
    }
    const items = itemsFromLoad(result)
    expect(items[0]!.disabled).toBe(true)
    expect(items[0]!.description).toBe("boom")
  })

  it("sorts by slug", () => {
    const result: LoadResult = {
      prompts: [
        { slug: "b", description: "", body: "", scope: "user", path: "/b.md" },
        { slug: "a", description: "", body: "", scope: "user", path: "/a.md" },
      ],
      broken: [],
    }
    expect(itemsFromLoad(result).map((i) => i.slug)).toEqual(["a", "b"])
  })
})
