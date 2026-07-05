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

describe("external plugin prompt audit", () => {
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

  test("does not reintroduce known stale prompt wording", () => {
    const bad = violations(
      modelFacingFiles(),
      /not curly `"\s*`, `"\s*`|inline <tui::memory> tag|<ma::plugin::interleave-thinking>/g,
      "stale wording",
    )
    expect(bad).toEqual([])
  })

  test("does not carry avoidable whitespace in prompt markdown", () => {
    const repeatedBlankLines = violations(promptFiles(), /\n{3,}/g, "3+ blank lines")
    const trailingWhitespace = violations(promptFiles(), /[ \t]+$/gm, "trailing whitespace")
    expect([...repeatedBlankLines, ...trailingWhitespace]).toEqual([])
  })

  // Model-facing prose belongs in external markdown (PROMPT.md / prompts/*.md),
  // not inlined as TS string literals in handlers (Gaston's prompt-hygiene
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
