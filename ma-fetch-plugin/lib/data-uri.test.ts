import { describe, expect, test } from "bun:test"

import { stripDataUris } from "./data-uri.ts"

describe("stripDataUris", () => {
  test("no-op without data:", () => {
    expect(stripDataUris("# hi\n\nbody")).toBe("# hi\n\nbody")
  })

  test("keeps tiny data-URIs", () => {
    const tiny = "data:image/png;base64," + "A".repeat(40)
    expect(stripDataUris(`![x](${tiny})`)).toContain(tiny)
  })

  test("scrubs large data-URIs", () => {
    const uri = "data:image/png;base64," + "A".repeat(400)
    const out = stripDataUris(`before\n${uri}\nafter`)
    expect(out).not.toContain(";base64,")
    expect(out).toContain("<ma::agent::redacted-asset")
    expect(out).toContain('tool="Fetch"')
    expect(out).toContain("before")
    expect(out).toContain("after")
    expect(out).toContain("<ma::agent::context-sanitizer")
  })
})
