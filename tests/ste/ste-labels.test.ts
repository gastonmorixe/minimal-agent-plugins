/**
 * The labels list (`tests/ste/dictionary/labels.json`): lowercase values that
 * a tool prints or accepts as free text, which the tool text names in a code
 * span (the IntercomPeers status `idle`, the SubAgentsMailbox kind `claim`).
 *
 * A label passes s19 only inside a code span. Each label must be a string
 * literal in the code of its source file (not in a comment), and the list is
 * pinned, so a new label is a reviewed test diff (REVIEW-C2 L1).
 *
 * @module tests/ste/ste-labels
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { readDictionaryData } from "./dictionary.ts"
import extraRules, { isVerb } from "./extra-rules.ts"
import { lintText } from "./ste-rules.ts"

/** The s19 snippets (lowercase) that the gate path gives for one text. */
function s19(text: string): string[] {
  return lintText(text, 0, "x.md", { role: "tool", extraFindings: extraRules, isVerb })
    .filter((f) => f.rule === "ste-s19-dictionary")
    .map((f) => f.snippet.toLowerCase())
}

/**
 * TypeScript source without comments. Strings and template text stay, so a
 * `//` inside a string is kept. Good enough for the label check: it reads
 * only the files that labels.json names.
 *
 * @param src - The source text.
 * @returns The text with every comment removed.
 */
function stripComments(src: string): string {
  let out = ""
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i] ?? ""
    const next = src[i + 1] ?? ""
    if (quote) {
      out += c
      if (c === "\\") {
        out += next
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    out += c
    i++
  }
  return out
}

describe("labels (labels.json)", () => {
  test("a label passes only inside a code span", () => {
    // `idle` and `stale` are IntercomPeers status labels.
    expect(s19("The session is idle.")).toContain("idle")
    expect(s19("The record is stale.")).toContain("stale")
    expect(s19("The status is `idle` or `stale`.")).toEqual([])
    expect(s19("A `hung` process.")).toEqual([])
  })

  test("each label is a string literal in the code of its source file", () => {
    const root = join(import.meta.dir, "..", "..")
    const labels = readDictionaryData().labels ?? []
    expect(labels.length).toBeGreaterThan(0)
    for (const entry of labels) {
      expect(/^[a-z]+$/.test(entry.word)).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(10)
      // Code only: a label in a comment is not a label (REVIEW-C2 L1).
      const code = stripComments(readFileSync(join(root, entry.source), "utf8"))
      expect(code.includes(`"${entry.word}"`), `${entry.word} in ${entry.source}`).toBe(true)
    }
  })

  test("the label list is pinned: a new label is a reviewed test diff", () => {
    const words = (readDictionaryData().labels ?? []).map((e) => `${e.word} @ ${e.source}`).sort()
    expect(words).toEqual([
      "blocker @ ma-sub-agents-plugin/lib/mailbox.ts",
      "busy @ ma-intercom-plugin/lib/liveness.ts",
      "claim @ ma-sub-agents-plugin/lib/mailbox.ts",
      "dead @ ma-intercom-plugin/lib/liveness.ts",
      "handoff @ ma-sub-agents-plugin/lib/mailbox.ts",
      "hung @ ma-intercom-plugin/lib/liveness.ts",
      "idle @ ma-intercom-plugin/lib/liveness.ts",
      "note @ ma-sub-agents-plugin/lib/mailbox.ts",
      "offline @ ma-intercom-plugin/lib/liveness.ts",
      "online @ ma-intercom-plugin/lib/liveness.ts",
      "stale @ ma-intercom-plugin/lib/liveness.ts",
    ])
  })

  test("stripComments drops line and block comments, and keeps strings", () => {
    const src = 'const a = "x" // "gizmo"\n/* "gizmo" */ const b = "y // not a comment"'
    const out = stripComments(src)
    expect(out.includes('"gizmo"')).toBe(false)
    expect(out.includes('"x"')).toBe(true)
    expect(out.includes('"y // not a comment"')).toBe(true)
  })
})
