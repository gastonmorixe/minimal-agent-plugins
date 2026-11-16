/**
 * Prompt style audit for the model-facing text that moved out of core.
 *
 * Ported from two deleted core audits (core-prompts-decouple step P3.6):
 * - core `src/prompts/prompt-audit.test.ts` (9f5711c): style rules over the
 *   core prompt markdown and the first-party PROMPT.md files.
 * - core `src/prompts/core-inline-prose-audit.test.ts` (9c8a820): the
 *   typographic-punctuation rule over the `PROMPTS.ts` text seams.
 *
 * The core text now lives here, so the same rules run over:
 * - every first-party `ma-*` plugin `prompts/**` markdown file (the old
 *   `src/prompts/**` markdown plus the plugins' own prompt fragments),
 * - every first-party `ma-*` top-level PROMPT.md,
 * - the non-test `.ts` files of the 3 text plugins (ma-base-prompt-plugin,
 *   ma-core-tools-plugin, ma-turn-recovery-plugin), which replace the core
 *   `PROMPTS.ts` seams. Only the rules the old inline-prose audit ran on
 *   `.ts` text (typographic punctuation) plus the stale-namespace rule run
 *   on them: the prose rules would fire on code.
 *
 * The audit fails when it finds 0 files, so a moved folder or a bad glob can
 * never make it pass in silence. Hits on today's text that predate the move
 * are listed in KNOWN_HITS (fixed in the later STE rewrite step, not here).
 * A KNOWN_HITS entry that no longer fires also fails, so the list only shrinks.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

const ROOT = resolve(import.meta.dir, "..", "..")

/** The 3 plugins that own the text core used to ship. */
const TEXT_PLUGINS = ["ma-base-prompt-plugin", "ma-core-tools-plugin", "ma-turn-recovery-plugin"]

interface PromptFile {
  rel: string
  text: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const abs = join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) out.push(...walk(abs))
    else if (stat.isFile()) out.push(abs)
  }
  return out
}

function firstPartyDirs(): string[] {
  return readdirSync(ROOT)
    .filter((name) => name.startsWith("ma-") && statSync(join(ROOT, name)).isDirectory())
    .sort()
}

/**
 * `ma-x/PROMPT.md` or `ma-x/prompts/**.md` (README.md excluded). Nested
 * `fixtures/prompts/` folders are test inputs, not shipped text, so the
 * `prompts/` folder must sit at the plugin root.
 */
function isPromptMarkdown(rel: string): boolean {
  const parts = rel.split("/")
  if (!rel.endsWith(".md") || basename(rel) === "README.md") return false
  if (parts.length === 2) return parts[1] === "PROMPT.md"
  return parts[1] === "prompts"
}

function isTextPluginSource(rel: string): boolean {
  const parts = rel.split("/")
  return (
    TEXT_PLUGINS.includes(parts[0]) &&
    rel.endsWith(".ts") &&
    !rel.endsWith(".test.ts") &&
    !rel.endsWith(".d.ts") &&
    !parts.includes("__fixtures__")
  )
}

function load(filter: (rel: string) => boolean): PromptFile[] {
  return firstPartyDirs()
    .flatMap((name) => walk(join(ROOT, name)))
    .map((abs) => relative(ROOT, abs))
    .filter(filter)
    .sort()
    .map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }))
}

function promptMarkdownFiles(): PromptFile[] {
  return load(isPromptMarkdown)
}

function textSourceFiles(): PromptFile[] {
  return load(isTextPluginSource)
}

/** Markdown plus the text-plugin `.ts` files (rules that are safe on code). */
function modelFacingFiles(): PromptFile[] {
  return [...promptMarkdownFiles(), ...textSourceFiles()]
}

/**
 * Blank out code fences, inline code spans, and URLs so prose rules do not
 * fire on code. Length and newlines are kept, so line numbers stay correct.
 */
function maskNonProse(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ")
  return text
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank)
    .replace(/^(?: {4,}|\t)[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\bhttps?:\/\/\S+/g, blank)
}

function proseFiles(): PromptFile[] {
  return promptMarkdownFiles().map((f) => ({ rel: f.rel, text: maskNonProse(f.text) }))
}

/**
 * The rule TYPE keyword of a numbered statement (`INS-01 MUST ...`,
 * `INS-02 If x, SHOULD ...`), as in the agents-rules schema. Only the keyword
 * in that slot is allowed. The same word in prose is still flagged.
 */
const RULE_TYPE_RE =
  /^[A-Z]+-\d{2}(?: \[\w+\])?(?: (?:When|While|If|Where) [^\n]*?,)? (?:MUST|SHOULD)(?: NOT)?$/

function isRuleTypeKeyword(file: PromptFile, match: RegExpExecArray): boolean {
  const lineStart = file.text.lastIndexOf("\n", match.index) + 1
  const head = file.text.slice(lineStart, match.index + match[0].length)
  return RULE_TYPE_RE.test(head)
}

/**
 * The writing-style plugin quotes the banned items as examples (the plugins
 * repo's own scripts/prompt-audit.test.ts exempts it the same way).
 */
function isWritingStyleQuoteExample(file: PromptFile): boolean {
  return file.rel === "ma-agent-writing-style-plugin/PROMPT.md"
}

/**
 * Hits that exist on the moved text today. Do not fix them here: the later
 * STE rewrite step rewrites this text. Format: `rel:line label: match`.
 */
const KNOWN_HITS = new Set<string>([
  // ma-agent-cloud is not `-plugin` suffixed, so the repo's own
  // scripts/prompt-audit.test.ts never scanned its PROMPT.md. It ships em
  // dashes and semicolons today.
  "ma-agent-cloud/PROMPT.md:9 typographic punctuation: \u2014",
  "ma-agent-cloud/PROMPT.md:10 typographic punctuation: \u2014",
  "ma-agent-cloud/PROMPT.md:14 typographic punctuation: \u2014",
  "ma-agent-cloud/PROMPT.md:15 typographic punctuation: \u2014",
  "ma-agent-cloud/PROMPT.md:16 typographic punctuation: \u2014",
  "ma-agent-cloud/PROMPT.md:17 typographic punctuation: \u2014",
  "ma-agent-cloud/PROMPT.md:5 semicolon in prose: ;",
  "ma-agent-cloud/PROMPT.md:9 semicolon in prose: ;",
  "ma-agent-cloud/PROMPT.md:23 semicolon in prose: ;",
  // A wire header value (`k=v; k=v;`), not prose. The 3 semicolons on line 1
  // produce the same hit string, so one entry covers them.
  "ma-llm-anthropic-plugin/prompts/billing.tmpl.md:1 semicolon in prose: ;",
])

const seenKnownHits = new Set<string>()

function lineOf(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split("\n").length
}

function violations(
  files: PromptFile[],
  pattern: RegExp,
  label: string,
  allow: (file: PromptFile, match: RegExpExecArray) => boolean = () => false,
): string[] {
  const out: string[] = []
  for (const file of files) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(file.text)) !== null) {
      if (!allow(file, match)) {
        const hit = `${file.rel}:${lineOf(file.text, match.index)} ${label}: ${match[0]}`
        if (KNOWN_HITS.has(hit)) seenKnownHits.add(hit)
        else out.push(hit)
      }
      if (match[0].length === 0) pattern.lastIndex++
    }
  }
  return out
}

describe("prompt audit (moved from core)", () => {
  test("finds the files it audits (never passes on 0 files)", () => {
    const md = promptMarkdownFiles()
    const ts = textSourceFiles()
    expect(md.length).toBeGreaterThan(0)
    expect(ts.length).toBeGreaterThan(0)
    // Each text plugin must contribute prompt markdown or text source.
    for (const plugin of TEXT_PLUGINS) {
      expect(modelFacingFiles().some((f) => f.rel.startsWith(`${plugin}/`))).toBe(true)
    }
    expect(md.some((f) => f.rel.endsWith("/PROMPT.md"))).toBe(true)
    expect(md.some((f) => f.rel.split("/")[1] === "prompts")).toBe(true)
  })

  test("does not reference stale tag namespaces", () => {
    const bad = violations(modelFacingFiles(), /<tui::|<ma::tui|<ma::plugin::/g, "stale namespace")
    expect(bad).toEqual([])
  })

  test("keeps prompts and text sources free of typographic punctuation drift", () => {
    const bad = violations(
      modelFacingFiles(),
      /[\u2014\u2013\u2192\u2026\u201c\u201d\u2018\u2019]/g,
      "typographic punctuation",
      isWritingStyleQuoteExample,
    )
    expect(bad).toEqual([])
  })

  test("avoids shout-case prompt directives in prompt markdown", () => {
    const bad = violations(
      promptMarkdownFiles(),
      /\b(?:ALWAYS|NEVER|IMPORTANT|REQUIRED|SHOULD|MUST|BACKGROUND|SAME|GENERIC|DETAILED|CURRENT|CAN|OWN|LIVE|LATEST|RECORDED|ONLY|FINAL|ALL)\b|Do NOT|does NOT|is NOT|are NOT|could NOT|you are NOT|NOT its|NOT the|REFUSES/g,
      "shout-case directive",
      isRuleTypeKeyword,
    )
    expect(bad).toEqual([])
  })

  test("keeps model-facing prose free of semicolons", () => {
    const bad = violations(proseFiles(), /;/g, "semicolon in prose", isWritingStyleQuoteExample)
    expect(bad).toEqual([])
  })

  test("keeps model-facing prose free of emoji", () => {
    const bad = violations(
      proseFiles(),
      /\p{Extended_Pictographic}/gu,
      "emoji",
      isWritingStyleQuoteExample,
    )
    expect(bad).toEqual([])
  })

  test("keeps model-facing prose free of sycophancy, disclaimers, and signposting", () => {
    const bad = violations(
      proseFiles(),
      /great question|\babsolutely!|\bcertainly!|i hope this helps|let me know if you'd like|as an ai language model|let's dive in|here's what you need to know|without further ado/gi,
      "sycophancy or signposting",
      isWritingStyleQuoteExample,
    )
    expect(bad).toEqual([])
  })

  test("does not put a thematic break before a heading", () => {
    const bad = violations(
      promptMarkdownFiles(),
      /^---[ \t]*\n(?:[ \t]*\n)*#/gm,
      "--- before heading",
    )
    expect(bad).toEqual([])
  })

  test("does not reintroduce known stale prompt wording", () => {
    const bad = violations(
      modelFacingFiles(),
      /SHOULD PLAN|PHASES with TASKs|not curly `"\s*`, `"\s*`|inline <tui::memory> tag/g,
      "stale wording",
    )
    expect(bad).toEqual([])
  })

  test("does not carry avoidable whitespace in prompt markdown", () => {
    const repeatedBlankLines = violations(promptMarkdownFiles(), /\n{3,}/g, "3+ blank lines")
    const trailingWhitespace = violations(promptMarkdownFiles(), /[ \t]+$/gm, "trailing whitespace")
    expect([...repeatedBlankLines, ...trailingWhitespace]).toEqual([])
  })

  // Keep this test last: bun runs the tests of a file in order, so every rule
  // above has run. A KNOWN_HITS entry that no longer fires is stale.
  test("every KNOWN_HITS entry still fires (the allowlist only shrinks)", () => {
    expect([...KNOWN_HITS].filter((hit) => !seenKnownHits.has(hit))).toEqual([])
  })
})
