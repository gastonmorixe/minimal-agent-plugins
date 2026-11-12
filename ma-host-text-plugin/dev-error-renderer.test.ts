import { describe, expect, test } from "bun:test"

import {
  type CoreErrorJson,
  createErrorRendererRegistry,
  InvariantError,
} from "@minimal-agent/core/errors"

import { createDevErrorRenderer, HOST_TEXT_PLUGIN_ID } from "./dev-error-renderer.ts"

const sample: CoreErrorJson = { kind: "SomeError", fields: { a: 1, b: ["x"] } }

describe("dev error renderer", () => {
  test("shows kind and fields as JSON", () => {
    expect(createDevErrorRenderer().render(sample)).toBe('SomeError {"a":1,"b":["x"]}')
  })

  test("covers every kind", () => {
    expect(createDevErrorRenderer().kinds).toBe("*")
  })

  test("JSON round trip renders the same as the live toJSON()", () => {
    const e = new InvariantError("x.y", { a: 1 })
    const r = createDevErrorRenderer()
    const rt = JSON.parse(JSON.stringify(e)) as CoreErrorJson
    expect(r.render(rt)).toBe(r.render(e.toJSON()))
    expect(r.render(rt)).toContain("InvariantError")
  })

  test("registers into the core registry and renders any kind", () => {
    const reg = createErrorRendererRegistry()
    reg.register(createDevErrorRenderer(), HOST_TEXT_PLUGIN_ID)
    expect(HOST_TEXT_PLUGIN_ID).toBe("ma-host-text-plugin")
    expect(reg.render(sample)).toBe('SomeError {"a":1,"b":["x"]}')
    expect(reg.render(new InvariantError("q", { n: 2 }))).toBe(
      'InvariantError {"invariant":"q","data":{"n":2}}',
    )
  })

  test("an unknown shape is not rendered through the registry", () => {
    const reg = createErrorRendererRegistry()
    reg.register(createDevErrorRenderer(), HOST_TEXT_PLUGIN_ID)
    expect(reg.render({ message: "boom" } as unknown as CoreErrorJson)).toBeUndefined()
  })

  test("the renderer declines a non CoreErrorJson input", () => {
    const r = createDevErrorRenderer()
    expect(r.render({ message: "boom" } as unknown as CoreErrorJson)).toBeUndefined()
    expect(r.render(null as unknown as CoreErrorJson)).toBeUndefined()
  })
})
