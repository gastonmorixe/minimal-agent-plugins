#!/usr/bin/env bun
/**
 * Meaning parity: show what a prompt rewrite removed.
 *
 * A style rewrite must not drop a fact. This tool compares the reviewed
 * version of a file with the working tree and lists every protected token that
 * disappeared: a number, a limit, a backticked name, a tag, a placeholder, a
 * path, an env var or a tool name.
 *
 * Usage:
 *   bun run scripts/ste-parity.ts                     # all changed prompt files
 *   bun run scripts/ste-parity.ts <file> [...]        # named files
 *   bun run scripts/ste-parity.ts --ref HEAD~1        # compare with another ref
 *
 * Exit 1 when a protected token is gone and `--strict` is set. Otherwise it
 * prints the list for a human review.
 *
 * @module scripts/ste-parity
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Plugins repo root: one level above this script. */
const ROOT = resolve(import.meta.dir, "..")

/** Tokens that carry a fact. A rewrite must keep them. */
/**
 * Tokens that carry a fact. A rewrite must keep them.
 *
 * A URL inside a code span is the code-span token, not a second URL token, so
 * it is reported once. A number is a quantity or a limit, not a list marker or
 * a step number.
 */
const PROTECTED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "tag", pattern: /<ma::[\s\S]*?\/?>/g },
  { label: "placeholder", pattern: /%%[A-Za-z0-9_]+%%/g },
  { label: "interpolation", pattern: /\$\{[^}\n]*\}/g },
  { label: "code span", pattern: /`[^`\n]+`/g },
  { label: "env var", pattern: /\b[A-Z][A-Z0-9_]{3,}\b/g },
  {
    label: "number",
    pattern: /(?<![\w`.$/\u2014-])\d[\d.,]*(?:[ \t]?(?:KB|MB|GB|B|s|ms|%|x))?(?![\w`/-])/g,
  },
  { label: "path", pattern: /(?<![\w`=])(?:~|\.)?\/[\w.-]*(?:\/[\w.-]*)+(?![\w`])/g },
  { label: "url", pattern: /(?<!`)https?:\/\/\S+/g },
]

/**
 * Collect protected tokens of a text, with their counts.
 *
 * @param text - Text to scan.
 * @returns A count for each `label` + token pair.
 */
function tokens(text: string): Map<string, number> {
  // A list marker (`1.`, `2)`) and a heading level are structure, not a fact.
  // Mask them first so a reflow does not read as a lost quantity.
  const masked = text.replace(/^[ \t]*\d+[.)][ \t]/gm, "  ").replace(/^#+[ \t]/gm, "  ")
  const out = new Map<string, number>()
  for (const { label, pattern } of PROTECTED) {
    pattern.lastIndex = 0
    for (const match of masked.matchAll(pattern)) {
      // A bare all-caps word is a section label or an emphasis word, not an env
      // var. STE forbids that shout case, so a rewrite may drop it by design.
      if (label === "env var" && isBareLabel(masked, match.index ?? 0, match[0])) continue
      // A sentence-ending period after a path is punctuation, not part of the
      // path: `config.jsonc.` and `config.jsonc,` are the same fact.
      const raw = label === "path" || label === "number" ? match[0].replace(/\.+$/, "") : match[0]
      const key = `${label}\u0000${raw}`
      out.set(key, (out.get(key) ?? 0) + 1)
    }
  }
  return out
}

/** True when an all-caps token is a standalone label, not part of an identifier. */
function isBareLabel(text: string, index: number, token: string): boolean {
  const before = text[index - 1] ?? " "
  const after = text[index + token.length] ?? " "
  if (/[A-Z0-9_]/.test(before) || /[A-Z0-9_]/.test(after)) return false
  // A real env var is used like a name: MINIMAL_AGENT_CLOUD_URL, MAX_TOKENS.
  // A label is one word with no underscore and no digit.
  return !/[_0-9]/.test(token)
}

/** Run a git command and return stdout, or an empty string when it fails. */
function git(args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
  } catch {
    return ""
  }
}

/** Changed prompt files against a ref. */
function changedFiles(ref: string): string[] {
  const out = git(["diff", "--name-only", ref, "--"])
  return out
    .split("\n")
    .filter(
      (file) =>
        file &&
        (file.endsWith("PROMPT.md") ||
          file.includes("/prompts/") ||
          file.endsWith("manifest.json")),
    )
}

/**
 * Compare two texts and return the protected tokens that were lost.
 *
 * @param before - The reviewed text.
 * @param after - The working-tree text.
 * @returns Lines that describe each lost token.
 */
export function lostTokens(before: string, after: string): string[] {
  const oldTokens = tokens(before)
  const newTokens = tokens(after)
  const lost: string[] = []
  for (const [key, count] of oldTokens) {
    const now = newTokens.get(key) ?? 0
    if (now >= count) continue
    const [label, value] = key.split("\u0000")
    lost.push(`${label} lost (${count} -> ${now}): ${value}`)
  }
  return lost
}

/**
 * Compare one file with its committed version.
 *
 * @param file - Repo-relative path.
 * @param ref - Git ref to compare with.
 * @returns The lost tokens, or an empty list.
 */
export function lostInFile(file: string, ref: string): string[] {
  const before = git(["show", `${ref}:${file}`])
  const abs = resolve(ROOT, file)
  if (!existsSync(abs)) return [`file deleted: ${file}`]
  const after = readFileSync(abs, "utf8")
  return lostTokens(before, after)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const strict = argv.includes("--strict")
  const refIndex = argv.indexOf("--ref")
  const ref = refIndex >= 0 ? (argv[refIndex + 1] ?? "HEAD") : "HEAD"
  const named = argv.filter((arg, i) => !arg.startsWith("--") && i !== refIndex + 1)
  const files = named.length > 0 ? named : changedFiles(ref)

  if (files.length === 0) {
    console.log(`No changed prompt files against ${ref}.`)
    process.exit(0)
  }

  let total = 0
  for (const file of files) {
    const lost = lostInFile(file, ref)
    if (lost.length === 0) {
      console.log(`OK   ${file}`)
      continue
    }
    total += lost.length
    console.log(`LOSS ${file}`)
    for (const line of lost) console.log(`  ${line}`)
  }

  console.log(`\n${files.length} files checked, ${total} lost tokens.`)
  if (total > 0) {
    console.log("A lost token is a dropped fact. Restore it, or record why it is gone.")
  }
  process.exit(strict && total > 0 ? 1 : 0)
}
