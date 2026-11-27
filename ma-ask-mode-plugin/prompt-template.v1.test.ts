/**
 * Text proof: PROMPT.md of this plugin is a short template with
 * `%sideband:...%` calls that core renders (the prompt diet trimmed it). With
 * the real codec it must give the fixture `__fixtures__/PROMPT.v1.md`
 * exactly. With no codec each call renders the kind name. Core sends the
 * section also when the mode is off, so the text must say that its rules
 * apply only while the mode is active (probe S03). The `refusalHint` of the
 * manifest repeats the diff rule and the no-workaround rule at the point of
 * refusal.
 *
 * @module ma-ask-mode-plugin/prompt-template.v1.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { expandTemplate } from "../ma-template-kit/src/index.ts"
import { pluginSideband } from "../tests/support/sideband.ts"

const SB = await pluginSideband()
const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), "utf8")

const MAX_PROMPT_BYTES = 400
const MAX_HINT_CHARS = 500

describe("prompt of ma-ask-mode-plugin", () => {
  const template = read("PROMPT.md")
  const prompt = expandTemplate(template, { sideband: SB })

  it("PROMPT.md: the real codec gives the fixture exactly", () => {
    expect(template).toContain("%%sideband:")
    expect(prompt).toBe(read("__fixtures__/PROMPT.v1.md"))
  })

  it("no codec: each call renders the kind name", () => {
    const text = expandTemplate(template)
    expect(text).not.toContain("%%")
    expect(text).not.toContain("ma::")
    for (const kind of ["mode-active", "mode-change"]) expect(text).toContain(kind)
  })

  it("PROMPT.md stays small", () => {
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MAX_PROMPT_BYTES)
  })

  it("PROMPT.md says that the rules apply only while the mode is active", () => {
    expect(prompt).toContain("apply only while this mode is active")
    // The fixture test pins the exact tag bytes. Here, check the names and the attrs only.
    expect(prompt).toContain('mode-active id="..." since="..." /> tag with `id="ask"`')
    expect(prompt).toContain('mode-change from="..." to="..." at="..." /> tag')
    expect(prompt).toContain('`to="ask"`')
    expect(prompt).toContain("With no such tag, the mode is off.")
  })

  it("PROMPT.md keeps the mode rules", () => {
    expect(prompt).toContain("`Edit` and `Write`")
    expect(prompt).toContain("unified diff")
    expect(prompt).toContain("fenced block")
    expect(prompt).toContain("not with `Bash` or a different tool")
  })

  it("PROMPT.md does not claim that the model can only read", () => {
    expect(prompt).not.toMatch(/only read/i)
  })
})

describe("refusalHint of ma-ask-mode-plugin", () => {
  const manifest = JSON.parse(read("manifest.json")) as {
    headless: { modes: { id: string; refusalHint: string }[] }
  }
  const hint = manifest.headless.modes[0].refusalHint

  it("is 500 chars or less", () => {
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT_CHARS)
  })

  it("carries the diff rule and the no-workaround rule", () => {
    expect(hint).toContain("`diff -u`")
    expect(hint).toContain("DiffViewerShowDiff")
    expect(hint).toContain("Do not make the change with Bash or another tool")
  })
})
