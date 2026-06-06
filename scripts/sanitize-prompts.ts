#!/usr/bin/env bun
/**
 * Normalize whitespace in prompt markdown to trim tokens the model never needs.
 *
 * Only PROMPT.md files ride the system prompt, so those are the default target.
 * Two transforms:
 *
 *   1. Reflow (default on): join each paragraph and each list item back onto a
 *      single line. Hard-wrapping at ~80 columns inserts a newline mid-sentence.
 *      Markdown renders the wrapped lines as one paragraph anyway, so every
 *      intra-paragraph newline is a wasted token. Reflow removes them while
 *      keeping the blank line that separates one block from the next.
 *   2. Blank-line normalize (always): strip trailing whitespace, collapse runs
 *      of 2+ blank lines to one, drop leading/trailing blanks, end with a single
 *      newline.
 *
 * Structure is preserved: headings, list items, blockquotes, tables, thematic
 * breaks, and fenced code blocks are never merged into a paragraph, and code
 * fences are emitted verbatim. Pass `--aggressive` to also drop ALL blank lines
 * (a wall of text: smaller, less readable). Pass `--no-reflow` for blank-line
 * normalize only.
 *
 * Usage:
 *   bun run scripts/sanitize-prompts.ts [--write] [--aggressive] [--no-reflow] [paths...]
 *
 * Without `--write` it is a dry run that reports the byte delta per file. With
 * no paths it scans every `ma-*-plugin/PROMPT.md`.
 *
 * @module scripts/sanitize-prompts
 */

import { Glob } from "bun"

interface Options {
  write: boolean
  aggressive: boolean
  reflow: boolean
  paths: string[]
}

/** Parse argv into {@link Options}. Pure. */
export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { write: false, aggressive: false, reflow: true, paths: [] }
  for (const a of argv) {
    if (a === "--write") opts.write = true
    else if (a === "--aggressive") opts.aggressive = true
    else if (a === "--no-reflow") opts.reflow = false
    else opts.paths.push(a)
  }
  return opts
}

/** Knobs for {@link sanitize}. */
export interface SanitizeOptions {
  /** Drop ALL blank lines (a wall of text). Default false. */
  aggressive?: boolean
  /** Join wrapped paragraph + list-item lines onto one line. Default true. */
  reflow?: boolean
}

// --- line classifiers (pure) ---
const isFence = (l: string): boolean => /^\s*(```|~~~)/.test(l)
const isHeading = (l: string): boolean => /^#{1,6}\s/.test(l)
const isListItem = (l: string): boolean => /^\s*([-*+]|\d+[.)])\s+/.test(l)
const isThematicBreak = (l: string): boolean => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l)
const isTableRow = (l: string): boolean => /^\s*\|/.test(l)
const isBlockquote = (l: string): boolean => /^\s*>/.test(l)
/** A line emitted on its own (never reflowed into an adjacent paragraph). */
const isStandalone = (l: string): boolean =>
  isHeading(l) || isThematicBreak(l) || isTableRow(l) || isBlockquote(l)

/**
 * Reflow wrapped paragraphs + list items onto single lines. Produces an array
 * of "emitted" lines (where `""` marks a blank separator) that the blank-line
 * pass then normalizes. Pure.
 *
 * Rules: a fenced code block is copied verbatim. Headings, thematic breaks,
 * tables, and blockquotes are emitted standalone. A list item starts a fresh
 * logical line and its wrapped continuations join onto it. Consecutive plain
 * lines join into one paragraph. A blank line flushes the current logical line.
 */
function reflowLines(input: string): string[] {
  const emitted: string[] = []
  let buf: string | null = null
  let inFence = false

  const flush = (): void => {
    if (buf !== null) {
      emitted.push(buf)
      buf = null
    }
  }

  for (const raw of input.split("\n")) {
    const line = raw.replace(/[ \t]+$/, "")

    if (inFence) {
      emitted.push(line)
      if (isFence(line)) inFence = false
      continue
    }
    if (isFence(line)) {
      flush()
      emitted.push(line)
      inFence = true
      continue
    }
    if (line.length === 0) {
      flush()
      emitted.push("")
      continue
    }
    if (isStandalone(line)) {
      flush()
      emitted.push(line)
      continue
    }
    if (isListItem(line)) {
      flush()
      buf = line
      continue
    }
    // Plain text: a new paragraph, or a wrapped continuation of the current
    // paragraph / list item.
    if (buf === null) buf = line
    else buf += ` ${line.trim()}`
  }
  flush()
  return emitted
}

/**
 * Normalize blank lines over a line array: collapse runs to one, drop
 * leading/trailing blanks, end with a single newline. Aggressive drops all
 * blanks. Pure.
 */
function normalizeBlanks(lines: readonly string[], aggressive: boolean): string {
  const out: string[] = []
  let pendingBlank = false
  for (const line of lines) {
    if (line.length === 0) {
      if (aggressive) continue
      if (out.length > 0) pendingBlank = true
      continue
    }
    if (pendingBlank) {
      out.push("")
      pendingBlank = false
    }
    out.push(line)
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`
}

/**
 * Normalize prompt markdown whitespace. Pure: text in, text out.
 */
export function sanitize(input: string, opts: SanitizeOptions = {}): string {
  const reflow = opts.reflow ?? true
  const aggressive = opts.aggressive ?? false
  const lines = reflow ? reflowLines(input) : input.split("\n").map((l) => l.replace(/[ \t]+$/, ""))
  return normalizeBlanks(lines, aggressive)
}

/** Rough token estimate (bytes / 4, the common heuristic). */
function estTokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, "utf8") / 4)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  let targets = opts.paths
  if (targets.length === 0) {
    const glob = new Glob("ma-*-plugin/PROMPT.md")
    targets = []
    for await (const p of glob.scan(".")) targets.push(p)
    targets.sort()
  }

  let totalSaved = 0
  for (const path of targets) {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      console.log(`skip (missing): ${path}`)
      continue
    }
    const before = await file.text()
    const after = sanitize(before, { aggressive: opts.aggressive, reflow: opts.reflow })
    const savedBytes = Buffer.byteLength(before, "utf8") - Buffer.byteLength(after, "utf8")
    const savedTok = estTokens(before) - estTokens(after)
    totalSaved += savedBytes
    const tag = savedBytes === 0 ? "clean" : opts.write ? "written" : "would save"
    console.log(`${tag}: ${path}  -${savedBytes}B (~${savedTok} tok)`)
    if (opts.write && savedBytes !== 0) await Bun.write(path, after)
  }
  console.log(
    `\ntotal: -${totalSaved}B across ${targets.length} file(s)${
      opts.write ? " (written)" : " (dry run; pass --write)"
    }`,
  )
}

if (import.meta.main) {
  await main()
}
