/**
 * Self-tests for the STE rules on template syntax: a `%%name%%` var or a
 * `%%sideband:...%%` call is not prose, and the prose next to it is still
 * checked. Split from `ste-rules.test.ts` (max-lines).
 *
 * @module tests/ste/ste-template-syntax.test
 */

import { describe, expect, test } from "bun:test"

import extraRules, { isVerb } from "./extra-rules.ts"
import { lintText, maskNonProse, type Role } from "./ste-rules.ts"

/** True when `lintText` reports `rule` for `text`. */
function hits(text: string, rule: string): boolean {
  return lintText(text).some((finding) => finding.rule === rule)
}

/** The s19 snippets (lowercase) that the gate path gives for one text. */
function s19(text: string, role: Role = "prose"): string[] {
  return lintText(text, 0, "x.md", { role, extraFindings: extraRules, isVerb })
    .filter((f) => f.rule === "ste-s19-dictionary")
    .map((f) => f.snippet.toLowerCase())
}

describe("template placeholders are template syntax, not prose", () => {
  test("a sideband placeholder gives no finding", () => {
    const line =
      'Then the harness adds a %%sideband:tag reflection-ack silence-for="K" reason="no round"%% text to the next turn.'
    expect(s19(line, "prose")).toEqual([])
    expect(lintText(line, 0, "x.md", { role: "prose", extraFindings: extraRules, isVerb })).toEqual(
      [],
    )
  })

  test("a prose word next to a placeholder is still checked", () => {
    const line = "Utilize the %%sideband:open intercom-inbox%% block %%name?%% now."
    const words = s19(line, "prose")
    expect(words).toContain("block")
    expect(words).not.toContain("sideband")
    expect(words).not.toContain("intercom-inbox")
    expect(hits(line, "ste-s4-banned-word")).toBe(true)
  })

  test("masking keeps the length and the lines; %%%% is a literal", () => {
    const raw =
      'A %%sideband:tag reflection-checkpoint round="N" cooldown-applied-seconds=@cooldownSec%% text.\nUse %%%% and %%name?%% here.'
    const masked = maskNonProse(raw)
    expect(masked.length).toBe(raw.length)
    expect(masked.split("\n").length).toBe(raw.split("\n").length)
    expect(masked).not.toContain("sideband")
    expect(masked).not.toContain("%%")
    expect(masked).toContain("A W")
  })
})
