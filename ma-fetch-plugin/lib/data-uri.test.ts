import { describe, expect, test } from "bun:test"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"

import { pluginSideband } from "../../tests/support/sideband.ts"

import { stripDataUris } from "./data-uri.ts"

const sb = await pluginSideband()

describe("stripDataUris", () => {
  test("no-op without data:", () => {
    expect(stripDataUris("# hi\n\nbody", sb)).toBe("# hi\n\nbody")
  })

  test("keeps tiny data-URIs", () => {
    const tiny = "data:image/png;base64," + "A".repeat(40)
    expect(stripDataUris(`![x](${tiny})`, sb)).toContain(tiny)
  })

  test("scrubs large data-URIs", () => {
    const uri = "data:image/png;base64," + "A".repeat(400)
    const out = stripDataUris(`before\n${uri}\nafter`, sb)
    expect(out).not.toContain(";base64,")
    expect(out).toContain("<ma::agent::redacted-asset")
    expect(out).toContain('tool="Fetch"')
    expect(out).toContain("before")
    expect(out).toContain("after")
    expect(out).toContain("<ma::agent::context-sanitizer")
  })
  test("a second pass replaces the old footer (one footer)", () => {
    const uri = "data:image/png;base64," + "A".repeat(400)
    const once = stripDataUris(`a ${uri}\n\nb ${uri}`, sb)
    const cut = once.lastIndexOf("\n\n")
    const body = once.slice(0, cut)
    expect(once.slice(cut + 2)).toContain('removed="2"')
    const twice = stripDataUris(`c ${uri}\n${once}\n`, sb)
    const stub = body.slice(2, body.indexOf("/>") + 2)
    const footer = sb.render("context-sanitizer", {
      attrs: { removed: 1, kinds: "data_uri", "chars-removed": 400, tool: "Fetch" },
    })
    expect(twice).toBe(`c ${stub}\n${body}\n\n${footer}`)
  })

  test("no sideband codec (NO_SIDEBAND): the text does not change", () => {
    const text = `x data:image/png;base64,${"A".repeat(400)} y`
    expect(stripDataUris(text, NO_SIDEBAND)).toBe(text)
    expect(stripDataUris(text, undefined)).toBe(text)
  })
})
