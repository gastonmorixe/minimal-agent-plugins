/**
 * Byte proof (design 50 section 6): the prompt files of this plugin are
 * templates with `%%sideband:...%%` calls. The plugin returns them as
 * `{ template, vars }` and core renders them. With the real codec the render
 * must give the old bytes exactly: the old files are in
 * `__fixtures__/*.v1.md`, and the old code filled only the `%%name%%` vars.
 * With no codec each call renders the kind name.
 *
 * @module ma-reflection-checkpoint-plugin/prompt-template.v1.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { expandTemplate, renderTemplate } from "../ma-template-kit/src/index.ts"
import { pluginSideband } from "../tests/support/sideband.ts"

import type { HookTemplateEntry, PromptTemplateText } from "./lib/host-types.ts"
import { attachmentEntry, loopSafetyText, toSeconds } from "./lib/text.ts"

const SB = await pluginSideband()
const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), "utf8")
const old = (name: string): string => read(`__fixtures__/${name}.v1.md`)
/** The old `fill`: the `%%name%%` vars only, no trim. */
const fillOld = (text: string, vars: Record<string, string | number>): string =>
  renderTemplate(text, vars, { trim: false })
/** Render a returned text as core does (S4, S7). */
const render = (x: PromptTemplateText | ""): string =>
  x === "" ? "" : expandTemplate(x.template, { vars: x.vars ?? {}, sideband: SB })

const VARS = { interval: 25, cooldownSec: 30, round: 7 }
const FILES = ["ack", "attachment.tmpl", "checkpoint-cooldown.tmpl", "checkpoint-plain.tmpl"]

describe("prompt templates of ma-reflection-checkpoint-plugin", () => {
  for (const name of FILES) {
    it(`prompts/${name}.md: the real codec gives the old bytes exactly`, () => {
      const template = read(`prompts/${name}.md`)
      expect(template).toContain("%%sideband:")
      expect(expandTemplate(template, { vars: VARS, sideband: SB })).toBe(fillOld(old(name), VARS))
    })
  }

  it("the system prompt section gives the old bytes (cooldown and plain)", () => {
    const heading = read("prompts/heading.md").trim()
    const intro = read("prompts/intro.md").trim()
    const section = (checkpoint: string): string =>
      [heading, "", intro, "", checkpoint, "", old("ack").trim()].join("\n")
    expect(render(loopSafetyText(25, 30_000))).toBe(
      section(fillOld(old("checkpoint-cooldown.tmpl").trim(), { interval: 25, cooldownSec: 30 })),
    )
    expect(render(loopSafetyText(25, 0))).toBe(
      section(fillOld(old("checkpoint-plain.tmpl").trim(), { interval: 25 })),
    )
    expect(loopSafetyText(0, 30_000)).toBe("")
  })

  it("the attachment gives the old bytes (tag line and prose)", () => {
    const tag = SB.render("reflection-checkpoint", {
      attrs: { round: 50, "cooldown-applied-seconds": toSeconds(60_000) },
    })
    const prose = fillOld(old("attachment.tmpl").trim(), { round: 50, cooldownSec: 60 })
    const entry = (sb?: typeof SB): string => {
      const e: HookTemplateEntry = attachmentEntry(50, 60_000, sb)
      expect(e.template).toBe(true)
      return expandTemplate(e.text, { vars: e.vars ?? {}, sideband: SB })
    }
    expect(entry(SB)).toBe(`${tag}\n${prose}`)
    expect(entry()).toBe(prose)
  })

  it("no codec: each call renders the kind name", () => {
    for (const name of FILES) {
      const text = expandTemplate(read(`prompts/${name}.md`), { vars: VARS })
      expect(text).not.toContain("%%")
      expect(text).not.toContain("ma::")
      expect(text).toContain("`reflection-ack`")
    }
    const cooldown = expandTemplate(read("prompts/checkpoint-cooldown.tmpl.md"), { vars: VARS })
    expect(cooldown).toContain("adds a `reflection-checkpoint` text")
  })
})
