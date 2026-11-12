/**
 * Byte-for-byte golden test for every memory prompt. The fixtures were
 * captured from the private engine before it was replaced by
 * `ctx.prompts.render`. Expected bytes must never change with the engine.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import createProvider from "../../ma-prompt-template-plugin/provider.ts"

import { buildSystemPrompt, type RenderFn } from "./summarize.ts"

const FIXTURES = join(import.meta.dirname, "__fixtures__", "prompt-bytes")

function fixture(name: string): Buffer {
  const buf = readFileSync(join(FIXTURES, name))
  expect(buf.length).toBeGreaterThan(0)
  return buf
}

/** Renderer from the real prompts.template provider, bound to this plugin dir. */
const render: RenderFn = (name, vars) =>
  createProvider().render({
    pluginId: "ma-memory-plugin",
    pluginDir: join(import.meta.dirname, ".."),
    name,
    ...(vars ? { vars } : {}),
  })

describe("memory prompt bytes", () => {
  it("framing.global.md", () => {
    expect(Buffer.from(render("framing.global.md")).equals(fixture("framing.global.txt"))).toBe(
      true,
    )
  })
  it("framing.project.md", () => {
    expect(Buffer.from(render("framing.project.md")).equals(fixture("framing.project.txt"))).toBe(
      true,
    )
  })
  it("summarize.tmpl.md", () => {
    const out = render("summarize.tmpl.md", { scopeFraming: "FIXED-SCOPE-FRAMING" })
    expect(Buffer.from(out).equals(fixture("summarize.tmpl.txt"))).toBe(true)
  })
  it("buildSystemPrompt global", () => {
    expect(
      Buffer.from(buildSystemPrompt("global", render)).equals(fixture("system.global.txt")),
    ).toBe(true)
  })
  it("buildSystemPrompt project", () => {
    expect(
      Buffer.from(buildSystemPrompt("project", render)).equals(fixture("system.project.txt")),
    ).toBe(true)
  })
})
