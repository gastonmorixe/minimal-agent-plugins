/**
 * Self-tests for the STE rules. Each rule needs a positive case and a
 * negative case, so a broken pattern fails loudly instead of passing a
 * corpus in silence.
 *
 * @module tests/ste/ste-rules.test
 */

import { describe, expect, test } from "bun:test"

import {
  DESCRIPTIVE_WORDS,
  INSTRUCTION_WORDS,
  lintText,
  maskNonProse,
  splitSentences,
  summarize,
  wordCount,
} from "./ste-rules.ts"

/** True when `lintText` reports `rule` for `text`. */
function hits(text: string, rule: string): boolean {
  return lintText(text).some((finding) => finding.rule === rule)
}

describe("ste rules", () => {
  test("banned word: utilize, leverage, facilitate, robust, seamless", () => {
    expect(hits("Utilize the tool.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Leverage the cache.", "ste-s4-banned-word")).toBe(true)
    expect(hits("It facilitates the change.", "ste-s4-banned-word")).toBe(true)
    expect(hits("A robust and seamless path.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Use the tool.", "ste-s4-banned-word")).toBe(false)
    expect(hits("The path is reliable and smooth.", "ste-s4-banned-word")).toBe(false)
  })

  test("banned connector: moreover, furthermore, additionally", () => {
    expect(hits("Moreover, the tool stops.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Furthermore, the tool stops.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Also, the tool stops.", "ste-s4-banned-word")).toBe(false)
  })

  test("banned word: ensure, commence, initiate, prior to, in order to", () => {
    expect(hits("Ensure the file exists.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Commence the run.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Prior to the run, read the file.", "ste-s4-banned-word")).toBe(true)
    expect(hits("Make sure the file exists.", "ste-s4-banned-word")).toBe(false)
    expect(hits("Before the run, read the file.", "ste-s4-banned-word")).toBe(false)
  })

  test("phrasal verb is a warning, not an error", () => {
    const findings = lintText("Turn on the mode.")
    const phrasal = findings.find((f) => f.rule === "ste-s5-phrasal-verb")
    expect(phrasal?.severity).toBe("warn")
    expect(hits("Set the mode.", "ste-s5-phrasal-verb")).toBe(false)
  })

  test("contraction", () => {
    expect(hits("It's the same file.", "ste-s6-contraction")).toBe(true)
    expect(hits("Do not run it.", "ste-s6-contraction")).toBe(false)
    expect(hits("The file does not exist.", "ste-s6-contraction")).toBe(false)
  })

  test("semicolon in prose", () => {
    expect(hits("Read the file; then write it.", "ste-s2-semicolon")).toBe(true)
    expect(hits("Read the file. Then write it.", "ste-s2-semicolon")).toBe(false)
  })

  test("a semicolon inside a code span is not prose", () => {
    expect(hits("Run `echo a; echo b`.", "ste-s2-semicolon")).toBe(false)
  })

  test("a wire header line is not prose", () => {
    const header = "x-anthropic-billing-header: cc_version=1.0.0; cc_entrypoint=cli; cch=00000;"
    expect(hits(header, "ste-s2-semicolon")).toBe(false)
    expect(hits("Read the file; then write it.", "ste-s2-semicolon")).toBe(true)
  })

  test("typographic punctuation", () => {
    expect(hits("Read the file \u2014 then write it.", "ste-s3-typographic")).toBe(true)
    expect(hits('The "mode" flag.', "ste-s3-typographic")).toBe(false)
  })

  test("sycophancy and signposting", () => {
    expect(hits("Great question! Read the file.", "ste-s9-sycophancy")).toBe(true)
    expect(hits("Please note that the file is large.", "ste-s9-sycophancy")).toBe(true)
    expect(hits("Read the file.", "ste-s9-sycophancy")).toBe(false)
  })

  test("long instruction sentence over the limit", () => {
    const words = Array.from({ length: INSTRUCTION_WORDS + 5 }, (_, i) => `word${i}`).join(" ")
    expect(hits(`Do ${words}.`, "ste-s1-long-sentence")).toBe(true)
    expect(hits("Do the work in one step.", "ste-s1-long-sentence")).toBe(false)
  })

  test("a long descriptive sentence is an error, a borderline one is a warning", () => {
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(" ")
    const long = lintText(`The harness ${words(DESCRIPTIVE_WORDS + 4)}.`)
    const sentence = long.find((f) => f.rule === "ste-s1-long-sentence")
    expect(sentence?.severity).toBe("error")
    const borderline = lintText(`Do ${words(INSTRUCTION_WORDS + 2)}.`)
    expect(borderline.find((f) => f.rule === "ste-s1-long-sentence")?.severity).toBe("warn")
  })

  test("a code span counts as one word, not zero", () => {
    // Word count must include each span as one word. `wordCount` on the masked
    // text is the direct measure: the bug dropped spans to zero.
    const line = "Use `a`, `b`, `c`, `d`, `e`, `f`, `g`, `h`, `i` and `j` in the task."
    expect(wordCount(maskNonProse(line))).toBe(15)
    expect(line.split(/\s+/).filter(Boolean).length).toBe(15)
  })

  test("an imperative behind a leading clause keeps the 20-word limit", () => {
    // 24 words: over the instruction limit of 20, under the description limit
    // of 25. Before the fix the leading clause made it descriptive.
    const body = Array.from({ length: 18 }, () => "task").join(" ")
    const found = lintText(`To show all tracked files, do ${body}.`).find(
      (f) => f.rule === "ste-s1-long-sentence",
    )
    expect(found).toBeDefined()
    expect(found?.severity).toBe("warn")
  })

  test("prose inside backticks is still linted, code is not", () => {
    // A quoted example string is prose: its semicolon and banned word count.
    const quoted = "Cut these openers: `Let me know if you would not stop; it is robust`."
    expect(hits(quoted, "ste-s2-semicolon")).toBe(true)
    expect(hits(quoted, "ste-s4-banned-word")).toBe(true)
    // Real code stays invisible.
    expect(hits("Run `echo a; echo b`.", "ste-s2-semicolon")).toBe(false)
    expect(hits("Call `ReportResult` now.", "ste-s4-banned-word")).toBe(false)
  })

  test("a split phrasal verb is caught", () => {
    expect(hits("The overlay turns every plugin on or off.", "ste-s5-phrasal-verb")).toBe(true)
    expect(hits("It sets the mode up now.", "ste-s5-phrasal-verb")).toBe(true)
    expect(hits("The overlay enables every plugin.", "ste-s5-phrasal-verb")).toBe(false)
  })

  test("shout case by pattern, not only by list", () => {
    expect(hits("You are performing a CONTEXT CHECKPOINT COMPACTION.", "ste-s8-shout-case")).toBe(
      true,
    )
    // A real acronym is not shout case.
    expect(hits("Agent Client Protocol (ACP) host mode.", "ste-s8-shout-case")).toBe(false)
    expect(hits("Run the MCP and JSON tools.", "ste-s8-shout-case")).toBe(false)
  })

  test("one word for one meaning", () => {
    expect(hits("Start the run, then begin again.", "ste-s10-inconsistent-term")).toBe(true)
    expect(hits("Start the run, then start again.", "ste-s10-inconsistent-term")).toBe(false)
  })

  test("a rule keyword line may use its keyword", () => {
    expect(hits("INS-01 MUST write in STE.", "ste-s8-shout-case")).toBe(false)
    expect(hits("The tool MUST write now.", "ste-s8-shout-case")).toBe(true)
  })

  test("masking keeps code, tags, placeholders and paths out of the prose rules", () => {
    const raw = "Use `x = 1;` in <ma::agent::x /> for %%home%%/sessions/{id}.jsonl."
    const masked = maskNonProse(raw)
    expect(masked).not.toContain(";")
    expect(masked).not.toContain("ma::agent")
    expect(masked.split("\n").length).toBe(raw.split("\n").length)
  })

  test("sentence split does not break on a version number or an abbreviation", () => {
    const sentences = splitSentences("Use version 1.2.3 of the tool, e.g. today. Then stop.")
    expect(sentences.length).toBe(2)
  })

  test("a placeholder counts as one word", () => {
    expect(wordCount("Read x from %%path%% now.")).toBe(5)
  })

  test("summarize counts errors and warnings", () => {
    const findings = lintText("Utilize the tool; it's robust.")
    const summary = summarize(findings)
    expect(summary.total).toBeGreaterThan(0)
    expect(summary.errors).toBeGreaterThan(0)
    expect(summary.byRule["ste-s4-banned-word"]).toBeGreaterThanOrEqual(2)
  })

  test("clean STE text has no findings", () => {
    const text = [
      "# Tool loop safety",
      "",
      "The tool loop has no fixed limit on the number of rounds.",
      "Read the file before you write it.",
      "Do not start a new turn.",
    ].join("\n")
    expect(lintText(text)).toEqual([])
  })

  test("findings are sorted by line", () => {
    const findings = lintText("Utilize this.\nAlso; this.\nEnsure that.")
    const lines = findings.map((f) => f.line)
    expect([...lines].sort((a, b) => a - b)).toEqual(lines)
  })
})
