import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import createProvider from "./provider.ts"
import { PromptTemplateError } from "./template.ts"

const pluginDir = join(import.meta.dir, "__fixtures__")

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
  test("render reads the host package reader first (embedded package)", () => {
    const asked: string[] = []
    const readText = (rel: string) => {
      asked.push(rel)
      return rel === "prompts/only-embedded.md" ? "Hi %%name%%" : null
    }
    const dir = join(pluginDir, "no-such-embedded-dir")
    const req = { pluginId: "x", pluginDir: dir, name: "only-embedded.md", readText }
    expect(p.render({ ...req, vars: { name: "E" } })).toBe("Hi E")
    expect(asked).toEqual(["prompts/only-embedded.md"])
  })
  test("render falls back to the disk when the reader has no such file", () => {
    const req = { pluginId: "x", pluginDir, name: "hello.md", readText: () => null }
    expect(p.render({ ...req, vars: { name: "W" } })).toBe("Hello W\n\nEnd")
  })
  test("render is stable across calls (memo)", () => {
    const req = { pluginId: "x", pluginDir, name: "hello.md", vars: { name: "W" } }
    expect(p.render(req)).toBe(p.render(req))
  })
})
