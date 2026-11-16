/**
 * The backtick-span classifier, locked with two tables.
 *
 * A backtick span used to be invisible to every rule. That let bad prose hide
 * in a code span: `utilize the robust path | ensure it works` passed with a
 * semicolon, two banned words and a long clause, because one `|` made the whole
 * span "code".
 *
 * These tables hold both directions:
 *
 * - EVASIONS are prose in a code span. Each one must produce a finding.
 * - CODE is real code. Each one must stay masked, so the gate never fails on a
 *   command, a query or a JSON shape.
 *
 * @module tests/ste/ste-spans.test
 */

import { describe, expect, test } from "bun:test"

import { lintText, looksLikeCode, maskNonProse, wordCount } from "./ste-rules.ts"

/** Bad prose in a code span. The classifier must call each one prose. */
const EVASIONS: readonly string[] = [
  "utilize the robust path | ensure it works",
  "and/or we utilize it; it is robust",
  "please utilize the robust tool; moreover ensure it",
  "please don't utilize it, it is robust",
  "result = we utilize it; it is robust",
  "we-utilize-the-robust-thing-moreover",
  "the path is a::b but we utilize it; it is robust",
  "use the a\\b form since we utilize it; it is robust",
  "call name() first and then utilize the robust path; moreover ensure it",
  "cost is $5 so we utilize it; it is robust",
  "use the a\u00a0b form and utilize it; it is robust",
  // Round 2: a structural check must not match ordinary English.
  "{we utilize it, moreover it is robust}",
  "[note: we utilize the robust tool, moreover]",
  "please utilize; then ensure robust results",
  "for best results; do utilize the robust path",
  "Update the robust plan; moreover utilize it",
  "With care we utilize it and moreover it is robust",
  "Drop it and utilize the robust tool",
  "utilize; robust; moreover",
  "utilize-robust-moreover",
]

/** Real code. The classifier must call each one code. */
const CODE: readonly string[] = [
  "git status --short",
  "bun run ste:strict",
  "grep -nE 'error:|FAIL'",
  "for f in *.md; do echo $f; done",
  "{ id, label, since, permissions: { allow, deny } }",
  'action: "add"',
  "export FOO=1",
  "kill -9 1234",
  "SELECT id FROM users WHERE x = 1",
  "ReportResult",
  "--status",
  "a/b.ts",
  "tool_result",
  "MINIMAL_AGENT_NET_DBG=1",
  "||",
  "x => x.id",
  "<ma::agent::mode-active />",
]

describe("backtick span classifier", () => {
  test("each evasion is classified as prose", () => {
    const wrong = EVASIONS.filter((span) => looksLikeCode(span))
    expect(wrong).toEqual([])
  })

  test("each evasion produces a finding", () => {
    const clean = EVASIONS.filter((span) => lintText(`Cut this: \`${span}\`.`).length === 0)
    expect(clean).toEqual([])
  })

  test("each code shape stays masked", () => {
    const wrong = CODE.filter((span) => !looksLikeCode(span))
    expect(wrong).toEqual([])
  })

  test("a masked code span counts as one word", () => {
    // A real code span: an identifier, so it is masked and counts once.
    expect(wordCount(maskNonProse("Run `ReportResult` now."))).toBe(3)
    // A three-word span stays prose by design, so it is counted as words.
    expect(wordCount(maskNonProse("Run `a b c` now."))).toBe(5)
  })

  test("the whole corpus is not judged on code", () => {
    // A sanity check on the mask itself: a span with four or more plain words
    // and no code shape is prose. This is the case that used to hide.
    expect(looksLikeCode("the tool does not stop at once")).toBe(false)
  })

  test("the tables are big enough to mean something", () => {
    expect(EVASIONS.length).toBeGreaterThanOrEqual(20)
    expect(CODE.length).toBeGreaterThanOrEqual(15)
  })
})
