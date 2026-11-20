/**
 * Self-tests for the STE rules. Each rule needs a positive case and a
 * negative case, so a broken pattern fails loudly instead of passing a
 * corpus in silence.
 *
 * @module tests/ste/ste-rules.test
 */

import { describe, expect, test } from "bun:test"

import { lostTokens } from "../../scripts/ste-parity.ts"

import { contractionStem, tokenize } from "./dictionary.ts"
import extraRules, { isVerb } from "./extra-rules.ts"
import {
  DESCRIPTIVE_WORDS,
  type ExtraFindings,
  type ExtraFindingsArgs,
  INSTRUCTION_WORDS,
  isPath,
  lintText,
  maskNonProse,
  PARAGRAPH_SENTENCES,
  paragraphs,
  type Role,
  RULE_IDS,
  type SteFinding,
  sentenceSpans,
  splitSentences,
  summarize,
  wordCount,
} from "./ste-rules.ts"
import { roleOf } from "./surfaces.ts"

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
      "# Tool loop",
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

/** Findings of one rule for a text in a role. */
function ruleHits(text: string, rule: string, role: Role = "prose"): SteFinding[] {
  return lintText(text, 0, "x.md", { role }).filter((finding) => finding.rule === rule)
}

/** Assert each string fires (or stays quiet) for one rule. */
function table(
  rule: string,
  fire: readonly string[],
  quiet: readonly string[],
  role: Role = "prose",
): void {
  const missed = fire.filter((text) => ruleHits(text, rule, role).length === 0)
  const noisy = quiet.filter((text) => ruleHits(text, rule, role).length > 0)
  expect({ missed, noisy }).toEqual({ missed: [], noisy: [] })
}

describe("engine: sentence spans, roles, context", () => {
  test("a span slices the same sentence from the raw text", () => {
    const raw = "See `a.b`. Then read it.\n- Item one. Item two."
    const spans = sentenceSpans(maskNonProse(raw))
    expect(spans.map((s) => raw.slice(s.start, s.end))).toEqual([
      "See `a.b`.",
      "Then read it.",
      "Item one.",
      "Item two.",
    ])
    expect(spans.map((s) => s.line)).toEqual([1, 1, 2, 2])
  })

  test("B1: the classifier reads the same sentence as the counter", () => {
    // A URL eats a period in the mask, so the old raw/masked index pairing
    // read the wrong raw sentence and missed this instruction.
    const body = Array.from({ length: 21 }, () => "task").join(" ")
    const text = `See https://x.io/a. Then read it. Do ${body}.`
    const found = ruleHits(text, "ste-s1-long-sentence")
    expect(found.length).toBe(1)
    expect(found[0]?.severity).toBe("warn")
  })

  test("B3: a repeated long sentence reports its own line", () => {
    const long = `The harness ${Array.from({ length: 30 }, () => "word").join(" ")}.`
    const lines = ruleHits(`${long}\n\n${long}`, "ste-s1-long-sentence").map((f) => f.line)
    expect(lines).toEqual([1, 3])
  })

  test("B4: word/word is prose, a path stays masked", () => {
    expect(ruleHits("It is robust/seamless.", "ste-s4-banned-word").length).toBe(2)
    expect(ruleHits("Utilize/leverage it.", "ste-s4-banned-word").length).toBe(2)
    expect(ruleHits("It's/that's fine.", "ste-s6-contraction").length).toBe(2)
    for (const path of ["src/a.ts", "~/.x/y", "a/b/", "core/src2", "tests/ste_x"]) {
      expect(isPath(path, " "), path).toBe(true)
    }
    expect(isPath("and/or", " ")).toBe(false)
    expect(isPath("x/y", "/")).toBe(true)
    expect(maskNonProse("Edit src/a/b.ts now.")).not.toContain("src")
  })

  test("roleOf: tool, param and prose surfaces", () => {
    const m = (locator: string, file = "ma-x-plugin/manifest.json") =>
      roleOf({ file, locator, kind: "manifest" })
    expect(m("headless.tools[0].trigger.tool.description")).toBe("tool")
    expect(m("headless.tools[0].trigger.tool.input_schema.properties.a.description")).toBe("param")
    expect(m("description")).toBe("prose")
    expect(m("headless.hostModes[0].description")).toBe("prose")
    expect(
      roleOf({
        file: "ma-core-tools-plugin/prompts/tools/read.md",
        locator: "(whole file)",
        kind: "prompts-md",
      }),
    ).toBe("tool")
    expect(
      roleOf({
        file: "ma-core-tools-plugin/tool-text.ts",
        locator: "PARAMS.file_path",
        kind: "inline-ts",
      }),
    ).toBe("param")
    expect(
      roleOf({ file: "core/src/tools/binary-guard.ts", locator: "L53", kind: "core-ts" }),
    ).toBe("param")
    expect(
      roleOf({ file: "ma-x-plugin/PROMPT.md", locator: "(whole file)", kind: "prompt-md" }),
    ).toBe("prose")
  })

  test("tool and param roles make every finding an error", () => {
    const text = "The job is running. Use a/b here."
    for (const role of ["tool", "param"] as const) {
      const findings = lintText(text, 0, "x.md", { role })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.every((f) => f.severity === "error" && f.role === role)).toBe(true)
    }
    const prose = lintText(text, 0, "x.md")
    expect(prose.every((f) => f.severity === "warn")).toBe(true)
  })

  test("a finding carries its offset and role", () => {
    const [finding] = ruleHits("Read it.\nUtilize it.", "ste-s4-banned-word")
    expect(finding?.offset).toBe(9)
    expect(finding?.line).toBe(2)
    expect(finding?.role).toBe("prose")
  })

  test("extraFindings is called once per text with the masked and raw text", () => {
    const calls: ExtraFindingsArgs[] = []
    const extra: ExtraFindings = (args) => {
      calls.push(args)
      return [{ rule: "ste-s20-tool-name", message: "m", snippet: "s", line: 1, severity: "error" }]
    }
    const findings = lintText("Use `CronList`.\nRead it.", 4, "f.json", {
      role: "tool",
      extraFindings: extra,
    })
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({
      masked: maskNonProse("Use `CronList`.\nRead it."),
      raw: "Use `CronList`.\nRead it.",
      lineOffset: 4,
      file: "f.json",
      role: "tool",
    })
    expect(findings.some((f) => f.rule === "ste-s20-tool-name" && f.role === "tool")).toBe(true)
  })

  test("the instruction classifier can use a verb list from the dictionary", () => {
    const body = Array.from({ length: 19 }, () => "task").join(" ")
    const text = `Queue the ${body}.`
    expect(ruleHits(text, "ste-s1-long-sentence").length).toBe(0)
    const ctx = { isVerb: (w: string) => w === "queue" }
    expect(lintText(text, 0, "", ctx).some((f) => f.rule === "ste-s1-long-sentence")).toBe(true)
  })

  test("every emitted rule id is in RULE_IDS", () => {
    for (const rule of [
      "ste-s13-paragraph",
      "ste-s14-abbreviation",
      "ste-s15-slash",
      "ste-s16-progressive",
      "ste-s17-modal",
      "ste-s18-fragment",
      "ste-s19-dictionary",
      "ste-s20-tool-name",
      "ste-s21-result-verb",
    ]) {
      expect(RULE_IDS).toContain(rule)
    }
  })
})

describe("ste-s7-passive (narrowed, STE 3.3)", () => {
  test("must fire and must stay quiet", () => {
    table(
      "ste-s7-passive",
      [
        "The file is read by the harness.",
        "The value can be changed.",
        "The file must not be deleted.",
        "It will be written to disk.",
        "The tool is to be used once.",
        "The file has been deleted.",
        "It was being written.",
      ],
      [
        "The file is installed.",
        "The pump is not damaged.",
        "The job is stopped.",
        "Read the file.",
        "The mode is set.",
      ],
    )
  })
})

describe("ste-s13-paragraph", () => {
  const seven = "Read it. ".repeat(7)
  test("must fire", () => {
    table(
      "ste-s13-paragraph",
      [
        "Read the file. ".repeat(7),
        "Read it. Read it. Read it.\nRead it. Read it. Read it. Read it.",
        "- Item one. Two. Three. Four. Five. Six. Seven.",
        "1. Step. A. B. C. D. E. F.",
        `> ${seven}`,
      ],
      [],
    )
  })
  test("must stay quiet", () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `- Item ${i}.`).join("\n")
    table(
      "ste-s13-paragraph",
      [],
      [
        "Read it. ".repeat(6),
        `${"Read it. ".repeat(4)}\n\n${"Read it. ".repeat(4)}`,
        `Use these actions:\n${bullets}`,
        "# A\nRead it. Read it. Read it.\n## B\nRead it. Read it. Read it. Read it.",
        `\`\`\`\n${"x. Y. Z.\n".repeat(20)}\`\`\``,
        "| A. B. | C. D. |\n".repeat(10),
        "Use version 1.2.3, for example today. Then stop.",
        `Read it. Read it. Read it.\n---\nRead it. Read it. Read it. Read it.`,
      ],
    )
  })
  test("paragraphs: a list item is its own paragraph", () => {
    const kinds = paragraphs(maskNonProse("Lead in.\n- a\n  more a\n- b\n\nText.")).map(
      (p) => p.kind,
    )
    expect(kinds).toEqual(["prose", "item", "item", "prose"])
    expect(PARAGRAPH_SENTENCES).toBe(6)
  })
})

describe("ste-s14-abbreviation", () => {
  test("must fire and must stay quiet", () => {
    table(
      "ste-s14-abbreviation",
      [
        "The job handle (e.g. j2).",
        "Use a key, e.g., Enter.",
        "E.g. this one.",
        "the path, i.e. the file",
        "a-z, 0-9, etc)",
        "files, dirs, etc.",
        "A vs B",
        "approx. 10 s",
        "cf. the README",
        "run it w/o a flag",
      ],
      [
        "Use `e.g.` in code.",
        "Read /etc/hosts.",
        "`etc/passwd`",
        "Open VS Code.",
        "the etcd store",
        "approximately 10 s",
        "the vs_code_id key",
        "the e2e test",
        "Fig. 2",
        "https://x.io/e.g./a",
      ],
    )
  })
  test("is an error in every role", () => {
    expect(ruleHits("A vs B", "ste-s14-abbreviation")[0]?.severity).toBe("error")
  })
})

describe("ste-s15-slash", () => {
  test("must fire and must stay quiet", () => {
    table(
      "ste-s15-slash",
      [
        "For type/key/keypress/mouse, use it.",
        "Modifiers: cmd/command, shift.",
        "For `list`/`clear-stale`: the dir.",
        "Use and/or.",
        "dead/offline",
        "reasoning/thinking mode",
        "tokens used / total",
        "Chrome/Chromium",
        "the Edit/Write tools",
        "low/medium/high",
      ],
      [
        "Edit src/a/b.ts now.",
        "See https://x.io/a/b.",
        "Run `git log a/b`.",
        "Use 5h / 7d windows.",
        "1000 KB/s",
        "Use -A/-B/-C.",
        "Type /config to open it.",
        "The /config command opens it.",
        "bbox[0] + bbox[2] / 2",
        "`session/new`",
        "Call session/new first.",
        "%%home%%/sessions/x",
        "~64KB / 1000 lines",
        "run it w/o a flag",
        "```\n`a`/`b`\n```",
      ],
    )
  })
})

describe("ste-s16-progressive", () => {
  test("must fire and must stay quiet", () => {
    table(
      "ste-s16-progressive",
      [
        "Stop speech that is playing.",
        "when recall is degrading",
        "what a peer is doing",
        "how long this run has been going",
        "when it is getting full",
        "whether a job is still talking",
        "The job is running.",
        "Using the cache, read the file.",
        "By supplying it, you select the app.",
        "It was being written.",
        "The run is not finishing.",
      ],
      [
        "The value is a string.",
        "The default is nothing.",
        "The file is missing.",
        "The job is pending.",
        "Show a warning.",
        "The setting is on.",
        "for incremental streaming reads",
        "Bring the app to the front.",
        "Thinking is on.",
        "The mode is `streaming`.",
        "The ceiling is 751.",
        "During the run, read it.",
      ],
    )
  })
})

describe("ste-s17-modal", () => {
  test("must fire and must stay quiet", () => {
    table(
      "ste-s17-modal",
      [
        "It may fail.",
        "facts that may have changed",
        "May be empty.",
        "You might need it.",
        "The call could time out.",
        "- May return null.",
        "You should read it.",
        "The tool shall stop.",
        "It would fail.",
        "Should it fail, stop.",
      ],
      [
        "Released in May 2026.",
        "Set `may` to true.",
        "the maybe flag",
        "dismay",
        "Mayday",
        "It can fail.",
        "INS-04 MAY use a tool.",
        "INS-05 SHOULD use a tool.",
        "INS-06 should use a tool.",
      ],
    )
  })
  test("may/might/should/shall/would are errors, could is a warning in every role", () => {
    for (const role of ["prose", "tool", "param"] as const) {
      expect(ruleHits("It may fail.", "ste-s17-modal", role)[0]?.severity).toBe("error")
      expect(ruleHits("It could fail.", "ste-s17-modal", role)[0]?.severity).toBe("warn")
    }
  })
})

describe("ste-s18-fragment", () => {
  test("F1 fires in any role", () => {
    for (const role of ["prose", "tool", "param"] as const) {
      table(
        "ste-s18-fragment",
        ["And how long this run has been going.", "But the job stops."],
        [],
        role,
      )
    }
  })
  test("F2 fires on a subjectless verb", () => {
    table(
      "ste-s18-fragment",
      ["Takes no input.", "Reads a file from the local filesystem."],
      [],
      "tool",
    )
    table("ste-s18-fragment", ["Supports *, ranges (1-5) and lists."], [], "param")
  })
  test("must stay quiet", () => {
    const quiet = [
      "Read the file.",
      "Do not use it for X.",
      "Required.",
      "Optional.",
      "Defaults to 10 minutes.",
      "Default: false.",
      "Example: wait for a port.",
      "Examples: a build, a test run.",
      "Alias for `content`, with the same meaning.",
      "The command to run",
      "The tool reads a file.",
      "This tool reads a file.",
      "Also, the job stops.",
      "Always read the file first.",
      "# Returns",
    ]
    table("ste-s18-fragment", [], quiet, "param")
    table("ste-s18-fragment", [], [...quiet, "Returns the path.", "Gives the id."], "tool")
  })
  test("F2 Returns belongs to s21 in the tool role, to s18 elsewhere", () => {
    expect(ruleHits("Returns the path.", "ste-s18-fragment", "param").length).toBe(1)
    expect(ruleHits("Returns the path.", "ste-s18-fragment", "tool").length).toBe(0)
  })
  test("is an error in the tool block and a warning in prose", () => {
    expect(ruleHits("Takes no input.", "ste-s18-fragment", "tool")[0]?.severity).toBe("error")
    expect(ruleHits("Takes no input.", "ste-s18-fragment", "prose")[0]?.severity).toBe("warn")
  })
})

describe("ste-s21-result-verb", () => {
  test("must fire in the tool role", () => {
    table(
      "ste-s21-result-verb",
      [
        "Returns the path.",
        "It gives a list.",
        "The tool returns a list.",
        "Gives the id.",
        "It returns the id.",
        "This tool returns X.",
        "Read it. Returns the path.",
      ],
      [],
      "tool",
    )
  })
  test("must stay quiet", () => {
    table(
      "ste-s21-result-verb",
      [],
      [
        "The tool gives the path.",
        "Return only the last N lines.",
        "The harness returns the id.",
        "Set `returns` to 1.",
        "The tool gives X. It also stops.",
      ],
      "tool",
    )
    table("ste-s21-result-verb", [], ["Bash returns the output.", "Returns the path."], "prose")
    table("ste-s21-result-verb", [], ["Returns the path."], "param")
  })
})

describe("ste-parity", () => {
  test("B9: `10s` and `10 s` are the same fact, a lost number is still lost", () => {
    expect(lostTokens("Wait 10s.", "Wait 10 s.")).toEqual([])
    expect(lostTokens("Wait 10 s.", "Wait 10s.")).toEqual([])
    expect(lostTokens("Wait 10s.", "Wait 20 s.").length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// REVIEW-C holes (M3, M4, M5, M7, m1, m4): each fix has a must-fire and a
// must-stay-quiet table that runs through the real gate path (lintText with
// the extra rules of extra-rules.ts).
// ---------------------------------------------------------------------------

/** The s19 snippets (lowercase) that the gate path gives for one text. */
function s19(text: string, role: Role = "prose"): string[] {
  return lintText(text, 0, "x.md", { role, extraFindings: extraRules, isVerb })
    .filter((f) => f.rule === "ste-s19-dictionary")
    .map((f) => f.snippet.toLowerCase())
}

/** Assert each text gives an s19 finding for the word (or no s19 finding). */
function s19Table(
  fire: ReadonlyArray<readonly [string, string]>,
  quiet: readonly string[],
  role: Role = "tool",
): void {
  const missed = fire.filter(([text, word]) => !s19(text, role).includes(word))
  const noisy = quiet.filter((text) => s19(text, role).length > 0)
  expect({ missed, noisy }).toEqual({ missed: [], noisy: [] })
}

describe("M3: every contraction is s6, and s19 judges the word in it", () => {
  test("s6 must fire and must stay quiet", () => {
    table(
      "ste-s6-contraction",
      [
        "It'd stop.",
        "It'll stop.",
        "You've read it.",
        "We're done.",
        "I'm done.",
        "He'll stop.",
        "It shouldn't stop.",
        "It wouldn't stop.",
        "It couldn't stop.",
        "It hasn't stopped.",
        "They haven't stopped.",
        "Frobnicate'll stop.",
        "It\u2019d stop.",
        "It's the file.",
        "Here's the file.",
        "Can't stop.",
      ],
      [
        "The file's name.",
        "The files' names.",
        "Read the user's file.",
        "Run `printf 'done' 'x'` now.",
        "The 'mode' flag and the 'read' value.",
        "The tool stops.",
      ],
    )
  })
  test("contractionStem: the word to judge, or undefined for a possessive", () => {
    const got = [
      "It'd",
      "can't",
      "Won't",
      "you've",
      "Frobnicate'll",
      "file's",
      "files'",
      "it's",
      "plain",
    ].map((w) => `${w}=${contractionStem(w) ?? "-"}`)
    expect(got).toEqual([
      "It'd=It",
      "can't=can",
      "Won't=Will",
      "you've=you",
      "Frobnicate'll=Frobnicate",
      "file's=-",
      "files'=-",
      "it's=it",
      "plain=-",
    ])
  })
  test("tokenize keeps a contraction for s19 as its stem", () => {
    const raw = "Frobnicate'll stop. The file's name."
    expect(tokenize(maskNonProse(raw), raw).map((t) => t.word)).toEqual([
      "Frobnicate",
      "stop",
      "The",
      "file's",
      "name",
    ])
  })
  test("s19 must fire on an unknown word in a contraction, and stay quiet on an approved one", () => {
    s19Table(
      [
        ["Frobnicate'll stop.", "frobnicate"],
        ["Gonna'd stop.", "gonna"],
      ],
      ["It'd stop.", "You've read it.", "Can't stop.", "The file's name."],
    )
  })
})

describe("M4: a one-word code span that reads as a word is judged by s19", () => {
  test("must fire and must stay quiet", () => {
    s19Table(
      [
        ["Give the `awesome` file.", "awesome"],
        ["Give the `stuff` and the `things` file.", "stuff"],
        ["Give the `stuff` and the `things` file.", "things"],
        ["Read the `frobnicator` now.", "frobnicator"],
      ],
      [
        // `list` is an enum value of a shipped tool (IntercomPeers `action`).
        "Set the value to `list`.",
        // An identifier shape: a dot, a slash, `_`, a digit, a capital, a hyphen.
        "Read `a.b`, `x/y`, `file_path`, `v2`, `getValue` and `clear-stale`.",
        // A code word: a JSON literal, a shell command, a key name.
        "Set it to `true`, `false` or `null`. Run `grep` or `sleep`. Push `ctrl`.",
        // One or two letters: a code, a flag or a key.
        "Use `cd`, `en` or `z`.",
        // A span inside a fence is code.
        "```\n`awesome`\n```",
      ],
    )
  })
  test("pending covers a span word in its own prose file only", () => {
    expect(s19("Give the `awesome` file.", "prose")).toEqual(["awesome"])
  })
})

describe("M5: hyphen joins", () => {
  test("s5 fires on a hyphen phrasal verb", () => {
    table(
      "ste-s5-phrasal-verb",
      ["Find-out the cause.", "Do a look-up.", "The set-up step.", "It turned-on the mode."],
      ["The read-only file.", "The sub-agent stops.", "The setup step.", "A built-in tool."],
    )
  })
  test("a join of 3 or more parts must be a compound entry (s19)", () => {
    s19Table(
      [
        ["Send it at-least-once.", "at-least-once"],
        ["Count the tokens-per-second.", "tokens-per-second"],
        ["The file-read-only-mode flag.", "file-read-only-mode"],
        // Each part is approved, so only the 3-part rule catches it.
        ["Give the read-only-file now.", "read-only-file"],
      ],
      [
        "The read-only file.",
        "The sub-agent stops.",
        "A built-in tool.",
        "Use `a1-b2-c3-d4` in the file.",
      ],
    )
  })
})

describe("M7: a technical noun is not a verb (STE 1.7)", () => {
  // The heuristic (dictionary.ts judgeTokens): the -s form of a TN that is
  // also a verb (an unapproved verb entry or a TN `verb` field) is the verb
  // when the next word opens an object noun phrase and the word before does
  // not mark a noun phrase.
  test("must fire and must stay quiet", () => {
    s19Table(
      [
        ["The tool requests a token.", "requests"],
        ["The tool logs every action.", "logs"],
        ["The helper logs the result.", "logs"],
        ["It targets the root.", "targets"],
        ["It caches the page.", "caches"],
        ["Builds the request.", "builds"],
        ["The tool costs a token.", "costs"],
        ["The lead led the worker.", "led"],
        ["The harness built the file.", "built"],
      ],
      [
        "Read the requests and the logs.",
        "Read 3 logs and two targets.",
        "Send the requests to the model.",
        "The harness writes logs of network requests and responses.",
        "Use Bash for shell work: builds, tests and git.",
        "Examine logs.",
        "Read the log, the request and the cache.",
        "The lead stops the worker.",
        "Keep the children in each file.",
        "All requests stop. Each log is a file.",
        "Read the logs the tool wrote. Keep 3 requests a turn.",
      ],
    )
  })
})

describe("m4: CamelCase and hyphen joins of general words", () => {
  test("a CamelCase token of general words is not a name", () => {
    s19Table(
      [
        ["The FileGive flag.", "filegive"],
        ["Use the GiveFile tool.", "givefile"],
        // Lowercase, these are general words. A CamelCase token is a name,
        // so only a TN entry passes it (`via any kind` would pass "give").
        ["GiVe the ReAd flag.", "give"],
        ["GiVe the ReAd flag.", "read"],
      ],
      ["Use the `FileGive` key.", "The JSON file."],
    )
  })
  test("a hyphen join of 4 parts is not a word", () => {
    s19Table([["The file-read-give-stop flag.", "file-read-give-stop"]], ["The read-only flag."])
  })
})
