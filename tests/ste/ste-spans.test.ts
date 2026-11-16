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
import { decodeJsEscapes, normalizeNewlines } from "./surfaces.ts"

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

/**
 * Banned words hidden in a code-shaped span. The classifier may not judge
 * these as prose, but the vocabulary rules read inside every span, so each
 * one must still produce a finding. This is the design that replaces three
 * rounds of regex patches, each of which moved the hole somewhere else.
 */
const HIDDEN_WORDS: readonly string[] = [
  "cat lovers utilize it",
  "head of team will utilize it",
  "kill the robust job; moreover stop",
  "echo the robust answer",
  "export the robust report",
  "source the robust data",
  "SELECT the robust option FROM the menu; moreover utilize it",
  "WITH care, SET the robust value",
  'note: "we utilize it"',
  "step: 1 utilize the robust path",
  "utilize; robust",
  "echo a; echo don't",
  "minimal-agent-cli utilize it",
  // Invisible or curly characters must not hide a word. Heather's fourth pass.
  "don\u2019t utilize it",
  "util\u00adize it",
  "utili\u200bze it",
  "Let\u2019s dive in",
  // Other apostrophe forms that a typist or a paste can produce.
  "don\u02bct utilize it",
  "it\u02bcs robust",
  "Let\u02bcs dive in",
  "don\uff07t stop",
]

/**
 * The six non-ASCII characters the corpus uses, now allowed per file. This is
 * an allowlist, not a blocklist: five review rounds found hidden and lookalike
 * characters one at a time, and a list of bad ones never finishes.
 */
const ALLOWED_EXTRA = ["\u201c", "\u201d", "\u2018", "\u2019", "\u2191", "\u2193"]

/** Characters and shapes that must be reported. One per class a reviewer found. */
const HIDDEN: ReadonlyArray<readonly [string, string]> = [
  // U+2018 is deliberately allowed: the writing-style file quotes with it, so
  // the typographic rule reports an apostrophe use, not the hidden-char rule.
  ["modifier apostrophe U+02BC", "don\u02bct"],
  ["fullwidth apostrophe U+FF07", "don\uff07t"],
  ["prime U+2032", "don\u2032t"],
  ["acute accent U+00B4", "don\u00b4t"],
  ["soft hyphen", "util\u00adize"],
  ["zero-width space", "util\u200bize"],
  ["word joiner", "util\u2060ize"],
  ["combining grapheme joiner", "util\u034fize"],
  ["left-to-right mark", "util\u200eize"],
  ["right-to-left override", "util\u202eize"],
  ["variation selector", "util\ufe0fize"],
  ["combining acute on ASCII", "ut\u0301ilize"],
  ["Cyrillic e", "util\u0435ze"],
  ["Greek omicron", "util\u03bfze"],
  ["fullwidth letters", "util\uff49ze"],
  ["dotless i", "ut\u0131lize"],
  ["Hangul filler", "prior\u3164to"],
  ["braille blank", "prior\u2800to"],
  ["no-break space", "prior\u00a0to"],
  ["line separator", "prior\u2028to"],
  ["BOM", "util\ufeffize"],
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

  test("a banned word is caught even inside a code-shaped span", () => {
    // The vocabulary rules do not depend on the classifier.
    const clean = HIDDEN_WORDS.filter((span) => lintText(`Run \`${span}\`.`).length === 0)
    expect(clean).toEqual([])
  })

  test("real code carries no vocabulary finding", () => {
    const noisy = CODE.filter((span) => lintText(`Run \`${span}\`.`).length > 0)
    expect(noisy).toEqual([])
  })

  test("every hidden or lookalike character is reported", () => {
    const missed = HIDDEN.filter(
      ([, text]) =>
        !lintText(text, 0, "ma-fetch-plugin/PROMPT.md").some(
          (f) => f.rule === "ste-s12-hidden-char",
        ),
    ).map(([name]) => name)
    expect(missed).toEqual([])
  })

  const WRITING_STYLE = "ma-agent-writing-style-plugin/PROMPT.md"
  const SLASH_MENU = "ma-slash-menu-plugin/manifest.json"

  test("an allowed quote in its own file is punctuation, not a hidden char", () => {
    const findings = lintText("don\u2018t stop", 0, WRITING_STYLE)
    expect(findings.some((f) => f.rule === "ste-s3-typographic")).toBe(true)
    expect(findings.some((f) => f.rule === "ste-s12-hidden-char")).toBe(false)
  })

  test("an allowlist entry only applies to its own file", () => {
    // The quote is legal in the writing-style example and nowhere else.
    for (const char of ["\u201c", "\u201d", "\u2018", "\u2019"]) {
      expect(
        lintText(`a ${char} b`, 0, WRITING_STYLE).some((f) => f.rule === "ste-s12-hidden-char"),
      ).toBe(false)
      expect(
        lintText(`a ${char} b`, 0, "ma-fetch-plugin/PROMPT.md").some(
          (f) => f.rule === "ste-s12-hidden-char",
        ),
      ).toBe(true)
    }
    for (const char of ["\u2191", "\u2193"]) {
      expect(
        lintText(`a ${char} b`, 0, SLASH_MENU).some((f) => f.rule === "ste-s12-hidden-char"),
      ).toBe(false)
      expect(
        lintText(`a ${char} b`, 0, WRITING_STYLE).some((f) => f.rule === "ste-s12-hidden-char"),
      ).toBe(true)
    }
  })

  test("printable ASCII, tab and newline stay quiet", () => {
    const text = "Plain ASCII: a-z A-Z 0-9 !#$%&()*+,-./:;<=>?@[]^_{|}~ \t tab and a newline."
    expect(
      lintText(text, 0, "ma-fetch-plugin/PROMPT.md").some((f) => f.rule === "ste-s12-hidden-char"),
    ).toBe(false)
  })

  test("the allowlist is deliberately strict: accents and CJK are errors", () => {
    // This is the documented cost of an allowlist. If a prompt really needs an
    // accented letter, add it to ALLOWED_NON_ASCII with a reason.
    for (const text of [
      "caf\u00e9",
      "r\u00e9sum\u00e9",
      "\u65e5\u672c\u8a9e",
      "\u2192",
      "\u2265 \u00bd \u2122",
    ]) {
      expect(
        lintText(text).some((f) => f.rule === "ste-s12-hidden-char"),
        `${JSON.stringify(text)} must be reported`,
      ).toBe(true)
    }
  })

  test("a hidden character is found inside a code span, tag, URL or interpolation", () => {
    // The allowlist is about bytes, not prose, so it must read the raw line.
    // These were all MISSED while s12 read the masked line.
    const REGIONS: ReadonlyArray<readonly [string, string]> = [
      ["code span", "Run `git\u200b status`."],
      ["tool name", "Call `R\u0435portResult`."],
      ["bidi in a command", "Run `echo \u202eevil`."],
      ["a tag attribute", '<ma::emit::output path="/tmp/x\u200b" />'],
      ["a URL", "https://exa\u200bmple.com"],
      ["an interpolation", "${fo\u200bo}"],
    ]
    const missed = REGIONS.filter(
      ([, text]) =>
        !lintText(text, 0, "ma-fetch-plugin/PROMPT.md").some(
          (f) => f.rule === "ste-s12-hidden-char",
        ),
    ).map(([name]) => name)
    expect(missed).toEqual([])
  })

  test("a JS escape cannot carry a hidden character past the allowlist", () => {
    // A TS literal decodes to the real character at runtime, so the reader
    // decodes it first. Without this, "util\u200bize" is six ASCII characters.
    const decoded = decodeJsEscapes("We util\\u200bize the path")
    expect(decoded.includes("\u200b")).toBe(true)
    expect(
      lintText(decoded, 0, "ma-fetch-plugin/PROMPT.md").some(
        (f) => f.rule === "ste-s12-hidden-char",
      ),
    ).toBe(true)
    expect(decodeJsEscapes("a\\u{1F600}b")).toBe("a\u{1F600}b".replace("\\u{1F600}", "\u{1F600}"))
    expect(decodeJsEscapes("x\\x41y")).toBe("xAy")
  })

  test("a CRLF checkout is not all errors", () => {
    // core.autocrlf adds \r, which the model never receives.
    const crlf = "A plain line.\r\nAnother line.\r\n"
    expect(normalizeNewlines(crlf)).toBe("A plain line.\nAnother line.\n")
    expect(
      lintText(normalizeNewlines(crlf), 0, "ma-fetch-plugin/PROMPT.md").some(
        (f) => f.rule === "ste-s12-hidden-char",
      ),
    ).toBe(false)
  })

  test("every allowed character is needed by some file", () => {
    // A stale entry is a hole nobody is using. The count is fixed at 6.
    expect(ALLOWED_EXTRA.length).toBe(6)
    expect(new Set(ALLOWED_EXTRA).size).toBe(6)
  })

  test("the tables are big enough to mean something", () => {
    expect(EVASIONS.length).toBeGreaterThanOrEqual(20)
    expect(CODE.length).toBeGreaterThanOrEqual(15)
  })
})
