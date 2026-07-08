#!/usr/bin/env bun
/**
 * Detect and map every string that reaches the model, and flag which ones can
 * be compressed to cut tokens.
 *
 * Model-facing surfaces in this repo (all ride the request that goes to the LLM):
 *
 *   1. `ma-*-plugin/PROMPT.md`         - system-prompt fragments
 *   2. `ma-*-plugin/prompts/*.md`      - templates read at load / per-turn
 *   3. `ma-*-plugin/manifest.json`     - tool + parameter `description` strings
 *   4. inline TS literals in lib/*.ts  - `systemPrompt:` / `description:` prose
 *
 * For each string the script records byte size and an estimated token count,
 * then runs a battery of compression heuristics (reflowable newlines, blank-line
 * runs, trailing whitespace, filler words, cross-corpus phrase repetition,
 * oversized descriptions). It reuses `sanitize()` from sanitize-prompts.ts to
 * measure the concrete byte/token win a whitespace pass would yield.
 *
 * Reports land in ./tmp/prompt-audits/:
 *   - inventory.md     human map of every model-facing string, grouped by plugin
 *   - compression.md   ranked compression opportunities with per-file detail
 *   - inventory.json   machine-readable dump of everything above
 *
 * Usage:
 *   bun run scripts/prompt-inventory.ts [--out DIR]
 *
 * @module scripts/prompt-inventory
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

import { sanitize } from "./sanitize-prompts.ts"

const ROOT = resolve(import.meta.dir, "..")

// --- token / byte helpers ---
const bytes = (s: string): number => Buffer.byteLength(s, "utf8")
/** Rough token estimate (bytes / 4, the common heuristic). */
const estTokens = (s: string): number => Math.ceil(bytes(s) / 4)

// --- surface kinds ---
type Kind = "PROMPT.md" | "prompts/*.md" | "manifest" | "inline-ts"

interface StringItem {
  plugin: string
  kind: Kind
  /** Where it lives: file rel path plus an optional locator (json path / symbol). */
  rel: string
  locator: string
  text: string
  bytes: number
  tokens: number
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "build" ||
      entry === "DerivedData" ||
      entry === "dist"
    )
      continue
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walk(abs))
    else if (st.isFile()) out.push(abs)
  }
  return out
}

function pluginDirs(): string[] {
  return readdirSync(ROOT)
    .filter((n) => n.startsWith("ma-") && n.endsWith("-plugin"))
    .sort()
}

/** Recursively collect every `description` string in a manifest, with json path. */
function collectManifestStrings(
  node: unknown,
  path: string,
  out: Array<{ locator: string; text: string }>,
): void {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectManifestStrings(v, `${path}[${i}]`, out))
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const child = path ? `${path}.${k}` : k
    if (k === "description" && typeof v === "string") {
      out.push({ locator: child, text: v })
    } else {
      collectManifestStrings(v, child, out)
    }
  }
}

/** The byte offset of the last `//` line-comment start at or before `idx` on its line. */
function inLineComment(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf("\n", idx - 1) + 1
  const before = text.slice(lineStart, idx)
  // A `//` before the match on the same line means it sits inside a comment.
  // (Naive: does not account for `//` inside a string on the same line, but a
  // `description:`/`systemPrompt:` key preceded by a string literal is not a
  // real assignment anyway, so treating it as a comment is the safe call.)
  return before.includes("//")
}

/**
 * Extract inline TS prose literals assigned to `systemPrompt:` or `description:`.
 * Handles single/double/backtick strings and simple adjacent-string concatenation
 * (`"a" +\n"b"`). Good enough to inventory; not a full TS parser.
 *
 * Skips matches inside `//` line comments and inline-code backticks (e.g. a
 * prose mention of "`description:`" in a doc comment), which would otherwise
 * capture comment text as a phantom prose string.
 */
export function collectInlineTsStrings(text: string): Array<{ locator: string; text: string }> {
  const out: Array<{ locator: string; text: string }> = []
  const re = /(?<!`)\b(systemPrompt|description)\s*:\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (inLineComment(text, m.index)) continue
    const field = m[1]
    let i = re.lastIndex
    const parts: string[] = []
    // Consume one-or-more string literals joined by `+`.
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++
      const q = text[i]
      if (q !== '"' && q !== "'" && q !== "`") break
      i++
      let buf = ""
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") {
          buf += text[i] + (text[i + 1] ?? "")
          i += 2
          continue
        }
        buf += text[i]
        i++
      }
      i++ // closing quote
      parts.push(buf)
      while (i < text.length && /\s/.test(text[i])) i++
      if (text[i] === "+") {
        i++
        continue
      }
      break
    }
    if (parts.length > 0) {
      const line = text.slice(0, m.index).split("\n").length
      const joined = parts.join("").replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'")
      // Only keep prose-ish literals (skip trivial identifiers / short flags).
      if (joined.trim().length >= 25) {
        out.push({ locator: `${field}@L${line}`, text: joined })
      }
    }
  }
  return out
}

function discover(): StringItem[] {
  const items: StringItem[] = []
  for (const plugin of pluginDirs()) {
    const dir = join(ROOT, plugin)
    for (const abs of walk(dir)) {
      const rel = relative(ROOT, abs)
      const base = basename(abs)

      if (base === "PROMPT.md") {
        const text = readFileSync(abs, "utf8")
        items.push({
          plugin,
          kind: "PROMPT.md",
          rel,
          locator: "(whole file)",
          text,
          bytes: bytes(text),
          tokens: estTokens(text),
        })
      } else if (rel.includes("/prompts/") && base.endsWith(".md")) {
        const text = readFileSync(abs, "utf8")
        items.push({
          plugin,
          kind: "prompts/*.md",
          rel,
          locator: "(whole file)",
          text,
          bytes: bytes(text),
          tokens: estTokens(text),
        })
      } else if (base === "manifest.json" && rel === `${plugin}/manifest.json`) {
        let json: unknown
        try {
          json = JSON.parse(readFileSync(abs, "utf8"))
        } catch {
          continue
        }
        const strings: Array<{ locator: string; text: string }> = []
        collectManifestStrings(json, "", strings)
        for (const s of strings) {
          items.push({
            plugin,
            kind: "manifest",
            rel,
            locator: s.locator,
            text: s.text,
            bytes: bytes(s.text),
            tokens: estTokens(s.text),
          })
        }
      } else if (
        base.endsWith(".ts") &&
        !base.endsWith(".test.ts") &&
        !base.endsWith(".fixtures.ts")
      ) {
        const text = readFileSync(abs, "utf8")
        const strings = collectInlineTsStrings(text)
        for (const s of strings) {
          items.push({
            plugin,
            kind: "inline-ts",
            rel,
            locator: s.locator,
            text: s.text,
            bytes: bytes(s.text),
            tokens: estTokens(s.text),
          })
        }
      }
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Compression heuristics
// ---------------------------------------------------------------------------

interface Finding {
  item: StringItem
  /** Bytes saved by a lossless whitespace/reflow pass. */
  whitespaceSaved: number
  /** Bytes of reflowable mid-paragraph newlines. */
  reflowNewlines: number
  blankRuns: number
  trailingWs: number
  /** High-confidence filler phrases (safe to rewrite). */
  fillersHigh: string[]
  /** Low-confidence intensifiers (usually droppable, sometimes load-bearing). */
  fillersLow: string[]
  /** Writing-style violations per ma-agent-writing-style-plugin rules. */
  style: string[]
  notes: string[]
}

// Verbose/filler wording that usually adds tokens without meaning. These are
// SUGGESTIONS to a human editor, never auto-applied (semantics can shift).
//
// Two tiers. HIGH-confidence entries are multiword phrases that are almost
// always pure padding (safe to rewrite). LOW-confidence entries are single
// intensifiers/hedges ("very", "actually") that are usually droppable but
// sometimes load-bearing, so they are reported separately to avoid drowning the
// real wins in noise.
const FILLERS_HIGH: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, '"to"'],
  [/\bplease note that\b/gi, "drop"],
  [/\bplease note\b/gi, "drop"],
  [/\bit is important to note that\b/gi, "drop"],
  [/\bit should be noted that\b/gi, "drop"],
  [/\bas mentioned (?:above|earlier|before)\b/gi, "drop"],
  [/\bkeep in mind that\b/gi, "drop"],
  [/\bbe aware that\b/gi, "drop"],
  [/\bin the event that\b/gi, '"if"'],
  [/\bdue to the fact that\b/gi, '"because"'],
  [/\bfor the purpose of\b/gi, '"for/to"'],
  [/\bat this point in time\b/gi, '"now"'],
  [/\ba (?:large )?number of\b/gi, '"many"'],
  [/\bthe vast majority of\b/gi, '"most"'],
  [/\bthat is to say\b/gi, "drop"],
  [/\bin the process of\b/gi, "drop"],
  [/\bwith regard to\b/gi, '"about"'],
  [/\bin terms of\b/gi, "often droppable"],
]
const FILLERS_LOW: Array<[RegExp, string]> = [
  [/\bsimply\b/gi, "usually droppable"],
  [/\bbasically\b/gi, "usually droppable"],
  [/\bactually\b/gi, "usually droppable"],
  [/\bvery\b/gi, "usually droppable"],
  [/\breally\b/gi, "usually droppable"],
]

// Writing-style violations per ma-agent-writing-style-plugin/PROMPT.md. Each
// entry is a rule from that doc reduced to a detectable pattern. The AI-word
// list mirrors the "kill the AI dictionary" section. These are model-facing
// prose, so the same anti-AI-smell rules apply here as to the agent's replies.
// The AI dictionary from ma-agent-writing-style-plugin. A few entries are
// context-sensitive: "harness"/"leverage" are banned as VERBS but fine as nouns
// ("the harness" is this runtime's proper name), so those are matched only when
// NOT preceded by an article. Handled below, not in this alternation.
const AI_WORDS =
  /\b(delve|tapestry|realm|embark|myriad|plethora|streamlines?|streamlining|resonates?|synergy|groundbreaking|revolutioniz\w*|transformative|testament|pivotal|seamless(?:ly)?|cutting-edge|vibrant|profound|intricate|meticulous|foster(?:s|ing)?|garner\w*|underscore\w*|showcase\w*|exemplif\w*|boasts?|crucial|comprehensive|nuanced|compelling|bolster\w*|overarching|unprecedented)\b/gi
// Verb-only bans: skip the noun sense that follows an article/possessive.
const AI_VERBS_CONTEXTUAL =
  /(?<!\b(?:the|a|an|this|that|our|its|your|their)\s)\b(leverages?|leveraging|harnesse?s?|harnessing)\b/gi
const STYLE_RULES: Array<[RegExp, string]> = [
  [/[\u2014]/g, "em-dash -> comma/period/rewrite"],
  [/[\u2013]/g, "en-dash -> hyphen/rewrite"],
  [/[\u201c\u201d\u2018\u2019]/g, "curly quote -> straight quote"],
  [/\b(serves as|stands as|functions as|represents)\b/gi, 'AI verb -> "is/are"'],
  [/\bnot just\b[^.]*\bbut\b/gi, '"not just X but Y" shape'],
  [/; /g, "semicolon -> period/comma (writing-style: almost never)"],
]

function analyze(item: StringItem): Finding {
  const { text } = item

  // Whitespace/reflow win: reuse the shipped sanitizer (lossless for .md).
  // For non-md surfaces we still measure it as an upper bound signal.
  const after = sanitize(text, { reflow: true, aggressive: false })
  const whitespaceSaved = Math.max(0, bytes(text) - bytes(after))

  // Reflowable mid-paragraph newlines: a `\n` NOT preceded/followed by a blank
  // line and not adjacent to a list/heading/fence marker.
  const lines = text.split("\n")
  let reflowNewlines = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i].trim()
    const nxt = lines[i + 1].trim()
    if (cur === "" || nxt === "") continue
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/.test(nxt)) continue
    if (/^(#{1,6}\s|```|~~~)/.test(cur)) continue
    reflowNewlines++
  }

  const blankRuns = (text.match(/\n[ \t]*\n[ \t]*\n/g) ?? []).length
  const trailingWs = (text.match(/[ \t]+$/gm) ?? []).length

  const matchFillers = (table: Array<[RegExp, string]>): string[] => {
    const out: string[] = []
    for (const [re, hint] of table) {
      const hits = text.match(re)
      if (hits) out.push(`${hits.length}x "${hits[0].trim()}" -> ${hint}`)
    }
    return out
  }
  const fillersHigh = matchFillers(FILLERS_HIGH)
  const fillersLow = matchFillers(FILLERS_LOW)

  const style: string[] = []
  // The writing-style plugin lists the banned words/punctuation AS EXAMPLES of
  // what to avoid, so its own copies are legitimate, not violations. Exempt it.
  const isStyleRulesDoc = item.plugin === "ma-agent-writing-style-plugin"
  const aiHits = isStyleRulesDoc
    ? null
    : [...(text.match(AI_WORDS) ?? []), ...(text.match(AI_VERBS_CONTEXTUAL) ?? [])]
  if (aiHits && aiHits.length > 0) {
    const uniq = [...new Set(aiHits.map((w) => w.toLowerCase()))]
    style.push(`AI-dictionary: ${uniq.map((w) => `"${w}"`).join(", ")}`)
  }
  if (!isStyleRulesDoc) {
    for (const [re, label] of STYLE_RULES) {
      const hits = text.match(re)
      if (hits) style.push(`${hits.length}x ${label}`)
    }
  }

  const notes: string[] = []
  if (item.kind === "manifest" && item.tokens > 90) {
    notes.push(
      `long ${item.locator.includes("properties") ? "param" : "tool"} description (${item.tokens} tok)`,
    )
  }
  if (reflowNewlines >= 3) notes.push(`${reflowNewlines} reflowable hard-wrap newlines`)
  if (blankRuns > 0) notes.push(`${blankRuns} run(s) of 3+ blank lines`)
  if (trailingWs > 0) notes.push(`${trailingWs} trailing-whitespace line(s)`)

  return {
    item,
    whitespaceSaved,
    reflowNewlines,
    blankRuns,
    trailingWs,
    fillersHigh,
    fillersLow,
    style,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Cross-surface duplication (PROMPT.md vs its own manifest tool descriptions)
// ---------------------------------------------------------------------------
//
// The original version emitted every overlapping 10-word window as a separate
// row, so one real duplication showed up as a dozen near-identical lines. This
// version finds the MAXIMAL shared phrase per pair once, using a word-level
// longest-common-substring, then keeps only phrases of >= MIN_WORDS. It also
// scopes to same-plugin PROMPT.md <-> manifest pairs, which are the only pairs
// that are realistically dedup-able (the two surfaces are authored together).

interface DupPhrase {
  plugin: string
  words: number
  phrase: string
  /** The two surface locators the phrase spans. */
  a: string
  b: string
  /** Tokens that a single shared fragment would reclaim (one of the two copies). */
  reclaimableTokens: number
}

/** Normalize prose to a word array for comparison. Lowercased, markup stripped. */
export function toWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[`*_#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

/** Word-level longest common substring between two word arrays. Pure, O(n*m). */
export function longestCommonRun(a: readonly string[], b: readonly string[]): string[] {
  let best: string[] = []
  const dp = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = 0
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prevDiag + 1
        if (dp[j] > best.length) best = a.slice(i - dp[j], i)
      } else {
        dp[j] = 0
      }
      prevDiag = tmp
    }
  }
  return best
}

/**
 * For each plugin, compare its PROMPT.md against each of its manifest tool/param
 * descriptions and report the single maximal shared phrase (at least MIN_WORDS). These
 * are the concrete "written twice" cases worth factoring or trimming.
 */
function crossSurfaceDuplication(items: StringItem[]): DupPhrase[] {
  const MIN_WORDS = 8
  const byPlugin = new Map<string, StringItem[]>()
  for (const it of items) {
    const arr = byPlugin.get(it.plugin) ?? []
    arr.push(it)
    byPlugin.set(it.plugin, arr)
  }
  const out: DupPhrase[] = []
  for (const [plugin, arr] of byPlugin) {
    const prompt = arr.find((i) => i.kind === "PROMPT.md")
    if (!prompt) continue
    const promptWords = toWords(prompt.text)
    const others = arr.filter((i) => i.kind === "manifest" || i.kind === "inline-ts")
    for (const other of others) {
      const run = longestCommonRun(promptWords, toWords(other.text))
      if (run.length < MIN_WORDS) continue
      const phrase = run.join(" ")
      out.push({
        plugin,
        words: run.length,
        phrase,
        a: prompt.rel,
        b: `${other.rel} :: ${other.locator}`,
        reclaimableTokens: estTokens(phrase),
      })
    }
  }
  return out.sort((a, b) => b.words - a.words)
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}kB` : `${n}B`
}

function buildInventoryMd(items: StringItem[]): string {
  const totalTok = items.reduce((s, i) => s + i.tokens, 0)
  const totalB = items.reduce((s, i) => s + i.bytes, 0)
  const byKind = new Map<Kind, { n: number; tok: number }>()
  for (const it of items) {
    const e = byKind.get(it.kind) ?? { n: 0, tok: 0 }
    e.n++
    e.tok += it.tokens
    byKind.set(it.kind, e)
  }

  const lines: string[] = []
  lines.push("# Model-facing string inventory")
  lines.push("")
  lines.push(`Generated ${new Date().toISOString()}`)
  lines.push("")
  lines.push(`Total: ${items.length} strings, ${fmtBytes(totalB)}, ~${totalTok} est tokens.`)
  lines.push("")
  lines.push("| Surface kind | strings | ~tokens |")
  lines.push("| --- | ---: | ---: |")
  for (const [k, e] of [...byKind].sort((a, b) => b[1].tok - a[1].tok)) {
    lines.push(`| ${k} | ${e.n} | ${e.tok} |`)
  }
  lines.push("")

  // Group by plugin.
  const byPlugin = new Map<string, StringItem[]>()
  for (const it of items) {
    const arr = byPlugin.get(it.plugin) ?? []
    arr.push(it)
    byPlugin.set(it.plugin, arr)
  }
  const plugins = [...byPlugin].sort(
    (a, b) => b[1].reduce((s, i) => s + i.tokens, 0) - a[1].reduce((s, i) => s + i.tokens, 0),
  )
  lines.push("## By plugin (heaviest first)")
  lines.push("")
  for (const [plugin, arr] of plugins) {
    const tok = arr.reduce((s, i) => s + i.tokens, 0)
    lines.push(`### ${plugin}  (~${tok} tok, ${arr.length} strings)`)
    lines.push("")
    lines.push("| kind | locator | ~tok | bytes |")
    lines.push("| --- | --- | ---: | ---: |")
    for (const it of arr.sort((a, b) => b.tokens - a.tokens)) {
      const loc = `${it.rel}${it.locator === "(whole file)" ? "" : ` :: ${it.locator}`}`
      lines.push(`| ${it.kind} | ${loc} | ${it.tokens} | ${it.bytes} |`)
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

function buildCompressionMd(findings: Finding[], dups: DupPhrase[]): string {
  const lines: string[] = []
  const loc = (f: Finding): string =>
    `${f.item.rel}${f.item.locator === "(whole file)" ? "" : ` :: ${f.item.locator}`}`

  const wsTotal = findings.reduce((s, f) => s + f.whitespaceSaved, 0)
  const bigDescs = findings
    .filter((f) => f.item.kind === "manifest" && f.item.tokens > 90)
    .sort((a, b) => b.item.tokens - a.item.tokens)
  const bigDescTok = bigDescs.reduce((s, f) => s + f.item.tokens, 0)
  const dupTok = dups.reduce((s, d) => s + d.reclaimableTokens, 0)
  const withHigh = findings.filter((f) => f.fillersHigh.length > 0)
  const withLow = findings.filter((f) => f.fillersLow.length > 0)

  lines.push("# Compression opportunities")
  lines.push("")
  lines.push(`Generated ${new Date().toISOString()}`)
  lines.push("")
  lines.push(
    "Token counts are estimates (bytes / 4). No exact tokenizer is available in this repo, so treat every `~tok` as a relative signal for ranking, not an exact budget.",
  )
  lines.push("")

  // Priority summary so the reader sees the real levers first.
  lines.push("## Priority summary (biggest levers first)")
  lines.push("")
  lines.push("| lever | scope | est. reclaimable tok | how |")
  lines.push("| --- | --- | ---: | --- |")
  lines.push(
    `| Trim oversized descriptions | ${bigDescs.length} manifest descriptions >90 tok | up to ~${Math.round(bigDescTok * 0.3)} (at ~30% trim) | hand-edit, see \u00a73 |`,
  )
  lines.push(
    `| Dedupe PROMPT.md <-> manifest | ${dups.length} shared phrases | ~${dupTok} if one copy removed | see \u00a74 (caveat inside) |`,
  )
  lines.push(
    `| Lossless whitespace/reflow | ${findings.filter((f) => f.whitespaceSaved > 0).length} files | ~${Math.ceil(wsTotal / 4)} | \`sanitize-prompts.ts --write\` |`,
  )
  lines.push(
    `| High-confidence filler | ${withHigh.length} strings | small, but free | hand-edit, see \u00a72 |`,
  )
  lines.push("")
  lines.push(
    `The dominant cost is not whitespace (~${Math.ceil(wsTotal / 4)} tok). It is the ~${bigDescTok} tok of long manifest descriptions that ride every request. Whitespace is a quick free win; description trimming is where the real budget is.`,
  )
  lines.push("")

  // 1. whitespace
  lines.push("## 1. Lossless whitespace / reflow")
  lines.push("")
  lines.push(
    `A reflow + blank-normalize pass (via \`sanitize-prompts.ts\`) saves ~${fmtBytes(wsTotal)} (~${Math.ceil(wsTotal / 4)} tok) with no meaning change. This is measured by actually running the shipped \`sanitize()\` on each string, so the byte figure is exact; only the token conversion is an estimate. Apply with:`,
  )
  lines.push("")
  lines.push("```")
  lines.push("bun run scripts/sanitize-prompts.ts --write   # PROMPT.md files")
  lines.push("```")
  lines.push("")
  lines.push(
    "Note: `sanitize()` is lossless for Markdown (`.md`) surfaces. The `reflow-\\n` column for manifest/inline-ts rows is an upper-bound signal only, since those are not reflowed in place.",
  )
  lines.push("")
  lines.push("| file :: locator | ws-saved (B) | reflow-\\n | blank-runs | trailing-ws |")
  lines.push("| --- | ---: | ---: | ---: | ---: |")
  for (const f of findings
    .filter((f) => f.whitespaceSaved > 0 || f.reflowNewlines > 0)
    .sort((a, b) => b.whitespaceSaved - a.whitespaceSaved)
    .slice(0, 60)) {
    lines.push(
      `| ${loc(f)} | ${f.whitespaceSaved} | ${f.reflowNewlines} | ${f.blankRuns} | ${f.trailingWs} |`,
    )
  }
  lines.push("")

  // 2. filler wording, tiered
  lines.push("## 2. Filler / verbose wording (manual review)")
  lines.push("")
  lines.push("### 2a. High-confidence (multiword padding, safe to rewrite)")
  lines.push("")
  if (withHigh.length === 0) lines.push("_None detected._")
  else {
    for (const f of withHigh.sort((a, b) => b.fillersHigh.length - a.fillersHigh.length)) {
      lines.push(`- **${loc(f)}**`)
      for (const fl of f.fillersHigh) lines.push(`  - ${fl}`)
    }
  }
  lines.push("")
  lines.push("### 2b. Low-confidence intensifiers (often droppable, sometimes load-bearing)")
  lines.push("")
  if (withLow.length === 0) lines.push("_None detected._")
  else {
    for (const f of withLow.sort((a, b) => b.fillersLow.length - a.fillersLow.length)) {
      lines.push(`- ${loc(f)}: ${f.fillersLow.join("; ")}`)
    }
  }
  lines.push("")

  // 2c. writing-style violations
  const withStyle = findings.filter((f) => f.style.length > 0)
  lines.push("### 2c. Writing-style violations (ma-agent-writing-style rules)")
  lines.push("")
  lines.push(
    "AI-dictionary words, em/en-dashes, curly quotes, and AI verb tics in model-facing prose. These surfaces are read by the model too, so the anti-AI-smell rules apply.",
  )
  lines.push("")
  if (withStyle.length === 0) lines.push("_None detected._")
  else {
    for (const f of withStyle.sort((a, b) => b.style.length - a.style.length)) {
      lines.push(`- **${loc(f)}**`)
      for (const s of f.style) lines.push(`  - ${s}`)
    }
  }
  lines.push("")

  // 3. oversized descriptions
  lines.push("## 3. Oversized manifest descriptions (>90 tok)")
  lines.push("")
  lines.push(
    `${bigDescs.length} descriptions, ~${bigDescTok} tok total. Long tool/param descriptions ride every request. Trim to the essential contract: what the tool does, its key constraints, one example. Cut the tutorial prose (that belongs in PROMPT.md, which loads once).`,
  )
  lines.push("")
  if (bigDescs.length === 0) lines.push("_None._")
  else {
    lines.push("| file :: locator | ~tok |")
    lines.push("| --- | ---: |")
    for (const f of bigDescs)
      lines.push(`| ${f.item.rel} :: ${f.item.locator} | ${f.item.tokens} |`)
  }
  lines.push("")

  // 4. cross-surface duplication (maximal phrase per pair)
  lines.push("## 4. PROMPT.md <-> manifest/inline duplication (maximal shared phrase)")
  lines.push("")
  lines.push(
    "The longest verbatim phrase each plugin's PROMPT.md shares with one of its manifest/inline descriptions (>= 8 words, one row per pair). These are literally written twice.",
  )
  lines.push("")
  lines.push(
    "Caveat: the two surfaces inject at DIFFERENT points (a tool `description` is attached when the tool is offered; PROMPT.md is a standing system fragment). You usually cannot delete one copy outright. The realistic win is to keep the tool description terse (the contract) and let PROMPT.md carry the depth, rather than paraphrasing the same paragraph in both. `reclaim-tok` is the ceiling if one copy were removed.",
  )
  lines.push("")
  if (dups.length === 0) lines.push("_None >= 8 words._")
  else {
    lines.push("| plugin | words | reclaim-tok | phrase (truncated) |")
    lines.push("| --- | ---: | ---: | --- |")
    for (const d of dups) {
      const p = d.phrase.length > 70 ? `${d.phrase.slice(0, 70)}...` : d.phrase
      lines.push(
        `| ${d.plugin} | ${d.words} | ${d.reclaimableTokens} | ${p.replace(/\|/g, "\\|")} |`,
      )
    }
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseOut(argv: readonly string[]): string {
  const i = argv.indexOf("--out")
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1])
  return resolve(ROOT, "tmp/prompt-audits")
}

function main(): void {
  const outDir = parseOut(process.argv.slice(2))
  mkdirSync(outDir, { recursive: true })

  const items = discover()
  const findings = items.map(analyze)
  const dups = crossSurfaceDuplication(items)

  const invMd = buildInventoryMd(items)
  const compMd = buildCompressionMd(findings, dups)

  const wsTotal = findings.reduce((s, f) => s + f.whitespaceSaved, 0)
  const json = {
    generated: new Date().toISOString(),
    totals: {
      strings: items.length,
      bytes: items.reduce((s, i) => s + i.bytes, 0),
      estTokens: items.reduce((s, i) => s + i.tokens, 0),
      whitespaceSavableBytes: wsTotal,
      whitespaceSavableTokens: Math.ceil(wsTotal / 4),
    },
    items,
    findings: findings.map((f) => ({
      rel: f.item.rel,
      locator: f.item.locator,
      kind: f.item.kind,
      tokens: f.item.tokens,
      whitespaceSaved: f.whitespaceSaved,
      reflowNewlines: f.reflowNewlines,
      blankRuns: f.blankRuns,
      trailingWs: f.trailingWs,
      fillersHigh: f.fillersHigh,
      fillersLow: f.fillersLow,
      style: f.style,
      notes: f.notes,
    })),
    crossSurfaceDuplication: dups,
  }

  writeFileSync(join(outDir, "inventory.md"), invMd)
  writeFileSync(join(outDir, "compression.md"), compMd)
  writeFileSync(join(outDir, "inventory.json"), `${JSON.stringify(json, null, 2)}\n`)

  const relOut = relative(ROOT, outDir)
  console.log(`Wrote reports to ${relOut}/`)
  console.log(`  inventory.md    ${items.length} strings across ${pluginDirs().length} plugins`)
  console.log(
    `  compression.md  ~${json.totals.estTokens} tok total, ~${json.totals.whitespaceSavableTokens} tok lossless-savable, ${dups.length} dup phrases`,
  )
  console.log(`  inventory.json  machine-readable dump`)
}

if (import.meta.main) {
  main()
}
