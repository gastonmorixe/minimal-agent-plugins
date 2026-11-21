/**
 * Byte proof (design 50 section 6): the prompt text of this plugin is a
 * template with `%sideband:...%` calls that core renders. With the real
 * codec it must give the old bytes exactly (`__fixtures__/*.v1.md`). With no
 * codec each call renders the kind name.
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
const old = (name: string): string => read(`__fixtures__/${name}.v1.md`)

/** The new templates and the names of their old-byte fixtures. */
const CASES: [label: string, template: () => string, fixture: string][] = [
  ["PROMPT.md", () => read("PROMPT.md"), "PROMPT"],
]

describe("prompt templates of ma-ask-mode-plugin", () => {
  for (const [label, template, fixture] of CASES) {
    it(`${label}: the real codec gives the old bytes exactly`, () => {
      expect(template()).toContain("%%sideband:")
      expect(expandTemplate(template(), { sideband: SB })).toBe(old(fixture))
    })
  }

  it("no codec: each call renders the kind name", () => {
    for (const [, template] of CASES) {
      const text = expandTemplate(template())
      expect(text).not.toContain("%%")
      expect(text).not.toContain("ma::")
    }
    const all = CASES.map(([, t]) => expandTemplate(t())).join("\n")
    for (const kind of ["mode-active", "mode-change"]) expect(all).toContain(`\`${kind}\``)
  })
})
