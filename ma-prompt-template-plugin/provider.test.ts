import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import createProvider from "./provider.ts"
import { PromptTemplateError } from "./template.ts"

const pluginDir = join(import.meta.dir, "fixtures")

describe("provider", () => {
  const p = createProvider()
  test("render reads <pluginDir>/prompts/<name>", () => {
    expect(p.render({ pluginId: "x", pluginDir, name: "hello.md", vars: { name: "W" } })).toBe(
      "Hello W\n\nEnd",
    )
  })
  test("render with optional present", () => {
    expect(
      p.render({ pluginId: "x", pluginDir, name: "hello.md", vars: { name: "W", opt: "O" } }),
    ).toBe("Hello W\nO\nEnd")
  })
  test("missing required throws PromptTemplateError", () => {
    expect(() => p.render({ pluginId: "x", pluginDir, name: "hello.md" })).toThrow(
      PromptTemplateError,
    )
  })
  test("expand is identity", () => {
    expect(p.expand("a {{sideband:k}} %%x%%")).toBe("a {{sideband:k}} %%x%%")
  })
  test("render is stable across calls (memo)", () => {
    const req = { pluginId: "x", pluginDir, name: "hello.md", vars: { name: "W" } }
    expect(p.render(req)).toBe(p.render(req))
  })
})
