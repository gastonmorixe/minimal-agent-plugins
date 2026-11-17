/**
 * s23: part of speech and meaning traps (REVIEW-B MF8).
 *
 * @module tests/ste/ste-pos.test
 */

import { describe, expect, test } from "bun:test"

import { loadPosIndex, POS_RULE, posFindings } from "./pos-rules.ts"
import { maskNonProse } from "./ste-rules.ts"

const INDEX = loadPosIndex()

/** The s23 snippets for one text, judged in the tool role. */
function snippets(text: string): string[] {
  return posFindings(
    { masked: maskNonProse(text), raw: text, lineOffset: 0, file: "x.md", role: "tool" },
    INDEX,
  ).map((f) => f.snippet)
}

describe("ste-s23-pos: a verb used as a noun (STE 1.2)", () => {
  test.each([
    ["Write the record to disk.", "the record"],
    ["Send a stop to the job.", "a stop"],
    ["The read gives the file.", "The read"],
    ["Each run uses a new shell.", "Each run"],
    ["Show each use of the tool.", "each use"],
    // REVIEW-C2 S23a: adjectives between the determiner and the verb.
    ["Give the full read.", "the full read"],
    ["Give your full read.", "your full read"],
    ["Give its full stop.", "its full stop"],
    ["Give a correct read of the file.", "a correct read"],
    // REVIEW-C2 S23b: a number, a possessive or another determiner.
    ["Give two reads of the file.", "two reads"],
    ["Give 2 reads of the file.", "2 reads"],
    ["Give the tool's read of the file.", "tool's read"],
    ["Give the file's read.", "file's read"],
    ["Give some reads of the file.", "some reads"],
    ["Give our read of the file.", "our read"],
    ["Give these reads.", "these reads"],
    // REVIEW-C2 S23f.
    ["Give its stop.", "its stop"],
  ])("fires: %s", (text, snippet) => {
    expect(snippets(text)).toContain(snippet)
  })

  test.each([
    "Record the result.",
    "Lock the file.",
    // `lock` is a technical noun (technical-nouns.json), so a determiner is correct.
    "Remove a lock.",
    "Read the file.",
    "Run the command.",
    "Stop the job.",
    // STE 3.3: a past participle can be an adjective.
    "Restart a stopped job.",
    "Show the recorded count.",
    "Show a cut line.",
    // A pronoun, not a determiner.
    "Give a job that runs for a long time.",
    "This is the default.",
    // A code span is masked: an enum value is not prose.
    "Use `list` to show the tasks.",
    // A technical noun (rule 1.5) may stand after a determiner, also when the
    // same spelling is an approved verb: `format` and `process` are both.
    "Give the format of the file.",
    "Stop the process.",
    // An -er form is an agent noun, not the verb (REVIEW lead finding).
    "The reader sees the text.",
    "The helper refuses the input.",
    // REVIEW-C2 near misses.
    "Give the full path.",
    "These files are new.",
    "Give some files.",
    // "this" and "that" are also pronouns: they stay out of the determiners.
    "Give this read of the file.",
    // A number after a noun is a value, not a determiner (real text).
    "With limit 20, the value 20 gives the page before.",
    "For a screenshot: 0 is usually the primary.",
    "Use 9 AM as the start.",
  ])("stays quiet: %s", (text) => {
    expect(snippets(text)).toEqual([])
  })
})

describe("ste-s23-pos: a noun or an adjective used as a verb (STE 1.2)", () => {
  test.each([
    ["Use the tool to check the file.", "to check"],
    ["The task must work.", "must work"],
    ["It can end the job.", "can end"],
    ["Do not empty the list.", "not empty"],
    // REVIEW-C2 S23c: after a subject pronoun or an adverb that starts an order.
    ["You test the file.", "You test"],
    ["They test the file.", "They test"],
    ["We test the file.", "We test"],
    ["You file the result.", "You file"],
    ["Then test the file.", "Then test"],
    ["Always test the file.", "Always test"],
    // REVIEW-C2 S23d: a modal + "not", or a modal + one adverb.
    ["You cannot file the result.", "cannot file"],
    ["You must not test the file.", "not test"],
    ["You can quickly test the file.", "can quickly test"],
    ["You will then empty the file.", "will then empty"],
    // REVIEW-C2 S23f.
    ["Do not test the file.", "not test"],
    // REVIEW-C2 M7b: an n-only lemma in its -s form after it/he/she/this.
    ["It tests the file.", "It tests"],
    ["This tests the file.", "This tests"],
    ["It reports the state.", "It reports"],
  ])("fires: %s", (text, snippet) => {
    expect(snippets(text)).toContain(snippet)
  })

  test.each([
    "Make a check of the file.",
    "The work is complete.",
    "At the end, stop.",
    "An empty list.",
    "Use the tool to find the file.",
    "It is not empty.",
    // REVIEW-C2 near misses.
    "You can read the file.",
    "You must not read the file.",
    "You will then read the file.",
    // "to" is also a preposition: a technical noun after it is not a verb.
    "Write it to disk.",
    // "it" is often an object, so it is not a subject for the base form.
    "Give it the file.",
    // A pronoun after a verb or a preposition is an object, not a subject.
    "The tool gives you the file.",
    // M7b stays narrow: "tool files" is also a compound noun.
    "The tool files the result.",
    // An adverb that starts a sentence does not make a technical noun a verb.
    "Then peers and teams can be on different machines.",
  ])("stays quiet: %s", (text) => {
    expect(snippets(text)).toEqual([])
  })
})

describe("ste-s23-pos: meaning traps (STE 1.3)", () => {
  test.each([
    ["The task fires every hour.", "fires"],
    ["It gives clear JSON.", "clear JSON"],
    ["Deletions are hot pink.", "hot"],
    ["Use it carefully.", "carefully"],
  ])("fires: %s", (text, snippet) => {
    expect(snippets(text)).toContain(snippet)
  })

  test("stays quiet on the approved sense", () => {
    expect(snippets("The file is clear.")).toEqual([])
    expect(snippets("Start the timer.")).toEqual([])
  })

  test("every finding is an error with the s23 id", () => {
    const found = posFindings(
      { masked: "the record", raw: "the record", lineOffset: 4, file: "x.md", role: "param" },
      INDEX,
    )
    expect(found.map((f) => [f.rule, f.severity, f.role, f.line])).toEqual([
      [POS_RULE, "error", "param", 5],
    ])
  })
})

describe("ste-s23-pos: the index", () => {
  test("knows the approved parts of speech that the rule depends on", () => {
    // Verified against ASD-STE100 Issue 9 Part 2 (the local reference): RECORD
    // and READ are approved only as verbs, CHECK and WORK only as nouns.
    expect([...(INDEX.pos.get("record") ?? [])]).toEqual(["v"])
    expect([...(INDEX.pos.get("read") ?? [])]).toEqual(["v"])
    expect([...(INDEX.pos.get("check") ?? [])]).toEqual(["n"])
    expect([...(INDEX.pos.get("work") ?? [])]).toEqual(["n"])
  })
})
