import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

const ROOT = resolve(import.meta.dir, "..")

interface PromptFile {
  rel: string
  abs: string
  text: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    // S42: a plugin can now have `node_modules/@minimal-agent/core` on disk
    // (the host dependency) -- its handler-shaped files are core's own, not
    // this plugin's, and must not feed the prompt-inlining audit below.
    if (entry === "node_modules") continue
    // `tmp/` and `.tmp/` are gitignored scratch copies of other checkouts.
    // Their text is not shipped, and reading 500 MB of it made this audit
    // slow enough to time out under the parallel test run.
    if (entry === "tmp" || entry === ".tmp") continue
    const abs = join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      out.push(...walk(abs))
    } else if (stat.isFile()) {
      out.push(abs)
    }
  }
  return out
}

function isPluginPromptSurface(rel: string): boolean {
  const parts = rel.split("/")
  return parts.length === 2 && parts[0].startsWith("ma-") && parts[0].endsWith("-plugin")
}

function modelFacingFiles(): PromptFile[] {
  return readdirSync(ROOT)
    .filter((name) => name.startsWith("ma-") && name.endsWith("-plugin"))
    .flatMap((name) => walk(join(ROOT, name)))
    .map((abs) => ({ abs, rel: relative(ROOT, abs), text: readFileSync(abs, "utf8") }))
    .filter(
      (file) =>
        isPluginPromptSurface(file.rel) &&
        (basename(file.rel) === "PROMPT.md" || basename(file.rel) === "manifest.json"),
    )
    .sort((a, b) => a.rel.localeCompare(b.rel))
}

function promptFiles(): PromptFile[] {
  return modelFacingFiles().filter((file) => basename(file.rel) === "PROMPT.md")
}

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
        out.push(`${file.rel}:${lineOf(file.text, match.index)} ${label}: ${match[0]}`)
      }
      if (match[0].length === 0) pattern.lastIndex++
    }
  }
  return out
}

function isWritingStyleQuoteExample(file: PromptFile): boolean {
  return file.rel === "ma-agent-writing-style-plugin/PROMPT.md"
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

/**
 * In a manifest, only `description` values reach the model as prose. Blank
 * everything else (keys, icons, enums) and keep line numbers.
 */
function manifestDescriptionsOnly(text: string): string {
  const keep = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let out = ""
  let last = 0
  let match: RegExpExecArray | null
  while ((match = keep.exec(text)) !== null) {
    const start = match.index + match[0].length - match[1].length - 1
    out += text.slice(last, start).replace(/[^\n]/g, " ") + match[1]
    last = start + match[1].length
  }
  return out + text.slice(last).replace(/[^\n]/g, " ")
}

function proseFiles(): PromptFile[] {
  // modelFacingFiles() builds fresh objects per call, so in-place is safe.
  return modelFacingFiles().map((file) =>
    Object.assign(file, {
      text: maskNonProse(
        basename(file.rel) === "manifest.json" ? manifestDescriptionsOnly(file.text) : file.text,
      ),
    }),
  )
}

describe("external plugin prompt audit", () => {
  // The slowest rule reads every prompt file twice (blank-line runs and
  // trailing whitespace), about 3-4 s alone, and it crossed the default 5 s
  // limit under the parallel run. Only that test needs the larger budget.
  const SLOW_MS = 30_000

  test("does not reference stale tag namespaces", () => {
    const bad = violations(modelFacingFiles(), /<tui::|<ma::tui|<ma::plugin::/g, "stale namespace")
    expect(bad).toEqual([])
  })

  test("keeps prompt markdown free of typographic punctuation drift", () => {
    // Scan every model-facing surface (PROMPT.md AND manifest.json tool
    // descriptions), not just PROMPT.md: a tool description is read by the
    // model too, so typographic drift there is the same hygiene bug.
    const bad = violations(
      modelFacingFiles(),
      /[—–→…“”‘’]/g,
      "typographic punctuation",
      isWritingStyleQuoteExample,
    )
    expect(bad).toEqual([])
  })

  test("avoids shout-case prompt directives in prompts and tool descriptions", () => {
    // Exempt a literal enum VALUE that happens to be all-caps: web-search's
    // `country` parameter accepts Brave's `"ALL"` sentinel (a wire value, not a
    // shout-case directive). Mirrors the core audit's `isLiteralEnumValue`.
    const isLiteralEnumValue = (file: PromptFile, match: RegExpExecArray): boolean =>
      file.rel === "ma-web-search-plugin/manifest.json" && match[0] === "ALL"
    const bad = violations(
      modelFacingFiles(),
      /\b(?:ALWAYS|NEVER|IMPORTANT|REQUIRED|SHOULD|MUST|BACKGROUND|SAME|GENERIC|NOT|ALL)\b|Do NOT|does NOT|is NOT|are NOT|REFUSES|ANY CDP|ONE connection|TWO layers|RAW INPUT|ACCESSIBILITY|ALL active/g,
      "shout-case directive",
      isLiteralEnumValue,
    )
    expect(bad).toEqual([])
  })

  test("keeps model-facing prose free of AI-dictionary words", () => {
    // The writing-style plugin bans a set of AI-tell words. Its own PROMPT.md
    // and manifest list them AS EXAMPLES, so that plugin is exempt. Everywhere
    // else, a hit is a real regression. "harness"/"leverage" are verb-only bans
    // (the noun "the harness" is this runtime's name), so they are checked with
    // a negative lookbehind for a preceding article/possessive.
    const isStyleRulesPlugin = (file: PromptFile): boolean =>
      file.rel.startsWith("ma-agent-writing-style-plugin/")
    const aiWords = violations(
      modelFacingFiles(),
      /\b(?:delve|tapestry|realm|embark|myriad|plethora|streamlines?|resonates?|synergy|groundbreaking|revolutioniz\w*|transformative|testament|pivotal|seamless(?:ly)?|cutting-edge|vibrant|profound|intricate|meticulous|garner\w*|underscore\w*|showcase\w*|exemplif\w*|boasts?|crucial|comprehensive|nuanced|compelling|bolster\w*|overarching|unprecedented)\b/g,
      "AI-dictionary word",
      isStyleRulesPlugin,
    )
    // "harness"/"leverage" are verb-only bans. The noun "the harness" (this
    // runtime's name) is fine, so skip a hit preceded by an article/possessive.
    // The lookbehind is case-insensitive so "The harness" at a sentence start is
    // also exempt.
    const aiVerbs = violations(
      modelFacingFiles(),
      /(?<![Tt]he\s|[Aa]n?\s|[Tt]his\s|[Tt]hat\s|[Oo]ur\s|[Ii]ts\s|[Yy]our\s|[Tt]heir\s)\b(?:leverages?|leveraging|harnesse?s?|harnessing)\b/g,
      "AI verb (use plain wording)",
      isStyleRulesPlugin,
    )
    expect([...aiWords, ...aiVerbs]).toEqual([])
  })

  // Writing-style rules from ma-agent-writing-style-plugin/PROMPT.md. That
  // plugin quotes the banned items as examples, so it is exempt.
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
    const bad = violations(promptFiles(), /^---[ \t]*\n(?:[ \t]*\n)*#/gm, "--- before heading")
    expect(bad).toEqual([])
  })

  test("does not reintroduce known stale prompt wording", () => {
    const bad = violations(
      modelFacingFiles(),
      /not curly `"\s*`, `"\s*`|inline <tui::memory> tag|<ma::plugin::interleave-thinking>/g,
      "stale wording",
    )
    expect(bad).toEqual([])
  })

  test(
    "does not carry avoidable whitespace in prompt markdown",
    () => {
      const repeatedBlankLines = violations(promptFiles(), /\n{3,}/g, "3+ blank lines")
      const trailingWhitespace = violations(promptFiles(), /[ \t]+$/gm, "trailing whitespace")
      expect([...repeatedBlankLines, ...trailingWhitespace]).toEqual([])
    },
    SLOW_MS,
  )

  // Model-facing prose belongs in external markdown (PROMPT.md / prompts/*.md),
  // not inlined as TS string literals in handlers (the owner's prompt-hygiene
  // rule). We flag a handler .ts that assigns a `systemPrompt:` field, since
  // that is a model-facing system prompt that should live in a prompts/*.md
  // read at load (the ma-tasks-plugin planning_fragment.ts + prompts/planning.md
  // pair is the reference pattern).
  //
  // ALLOWLIST: ma-sub-agents-plugin/lib/library.ts. Its per-specialist
  // systemPrompt strings are DELIBERATELY shipped as typed WorkerDefinition
  // objects (see the file header: "Shipped as typed objects rather than parsed
  // `.md` frontmatter so they are type-safe and testable"). They are compact,
  // structured worker DEFINITIONS closer to config than to freeform prose, the
  // shared discipline clause is already external (imported from ./prompts.ts),
  // and they are tested as typed objects. Externalizing to .md would trade that
  // type-safety + test coverage for marginal gain. The `.md`-frontmatter
  // discovery the header calls "an additive follow-up" is a separate feature,
  // not a hygiene fix.
  const INLINE_SYSTEM_PROMPT_ALLOW = new Set(["ma-sub-agents-plugin/lib/library.ts"])

  test("does not inline model-facing system prompts in handler .ts", () => {
    const handlerTs = readdirSync(ROOT)
      .filter((name) => name.startsWith("ma-") && name.endsWith("-plugin"))
      .flatMap((name) => walk(join(ROOT, name)))
      .map((abs) => ({ abs, rel: relative(ROOT, abs), text: readFileSync(abs, "utf8") }))
      .filter(
        (file) =>
          file.rel.endsWith(".ts") &&
          !file.rel.endsWith(".test.ts") &&
          !file.rel.endsWith(".fixtures.ts"),
      )
      .sort((a, b) => a.rel.localeCompare(b.rel))

    const bad = violations(
      handlerTs,
      /\bsystemPrompt\s*:\s*(?:"|'|`)/g,
      "inlined model-facing systemPrompt (externalize to prompts/*.md)",
      (file) => INLINE_SYSTEM_PROMPT_ALLOW.has(file.rel),
    )
    expect(bad).toEqual([])
  })
})
