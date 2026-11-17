#!/usr/bin/env bun
/**
 * Dictionary tool for `ste-s19-dictionary` (ASD-STE100 rule 1.1).
 *
 * Usage:
 *   bun run ste:dict --unknown [--role tool|param|prose] [--file x]
 *       List the unknown and unapproved words with counts and locations.
 *   bun run ste:dict --write-pending
 *       Regenerate `tests/ste/dictionary/pending.json` from the tree, and lower
 *       the pending counts of `tests/ste/ratchet-lock.json`. It refuses a new
 *       (word, file) pair and a higher occurrence count than the lock. The
 *       lock is the ceiling, never the merge base (REVIEW-C B1).
 *   bun run ste:dict --verify
 *       Check the word lists against the local reference dictionary
 *       (`~/.minimal-agent/ste/ste100-issue9.json`, or env `STE_REFERENCE`).
 *
 * The corpus and verifier helpers are exported, so `ste-dictionary.test.ts`
 * uses the same code as this script.
 *
 * @module scripts/ste-dict
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  DICTIONARY_DIR,
  type Dictionary,
  type DictionaryData,
  lemmaCandidates,
  loadDictionary,
  type PendingEntry,
  type Pos,
  readDictionaryData,
  surfaceRole,
  tokenize,
} from "../tests/ste/dictionary.ts"
import {
  LOCK_PATH,
  lockCeiling,
  lockHistory,
  lockKey,
  pendingAdditions,
  readLock,
  writeLock,
} from "../tests/ste/ratchet.ts"
import { maskNonProse } from "../tests/ste/ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "../tests/ste/surfaces.ts"

/** One prose token of the corpus, with where it is. */
export interface CorpusToken {
  /** The token as written. */
  word: string
  /** Lowercase form, the key of `pending`. */
  form: string
  file: string
  locator: string
  line: number
  role: "tool" | "param" | "prose"
}

/**
 * Every prose token of every model-facing surface, after `maskNonProse`.
 *
 * @returns The tokens, in surface order.
 */
export function corpusTokens(): CorpusToken[] {
  const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const out: CorpusToken[] = []
  for (const surface of surfaces) {
    const role = surfaceRole(surface)
    const masked = maskNonProse(surface.text)
    let line = surface.line
    let cursor = 0
    for (const token of tokenize(masked, surface.text)) {
      for (; cursor < token.index; cursor++) if (masked.charCodeAt(cursor) === 10) line++
      out.push({
        word: token.word,
        form: token.word.toLowerCase().replace(/\u2019/g, "'"),
        file: surface.file,
        locator: surface.locator,
        line,
        role,
      })
    }
  }
  return out
}

/** The lemmas a corpus form can come from, lowercased. */
export function corpusLemmas(tokens: readonly CorpusToken[], data: DictionaryData): Set<string> {
  const out = new Set<string>()
  for (const token of tokens) {
    for (const candidate of lemmaCandidates(token.form, data.irregular)) out.add(candidate.lemma)
    // A hyphenated word also uses each of its parts.
    if (token.form.includes("-")) {
      for (const part of token.form.split("-")) {
        for (const candidate of lemmaCandidates(part, data.irregular)) out.add(candidate.lemma)
      }
    }
  }
  return out
}

/**
 * The stale guard: every TN, TV and compound entry that no corpus form uses.
 * These entries ALLOW a word, so an unused one is a hole that a future text
 * can use without review: it fails. Unapproved entries are exempt: they are
 * the fix map ("use X"), and a rewrite that removes the word is the goal, so
 * an unapproved word that no text uses any more is the success case.
 *
 * @param data - The dictionary data.
 * @param lemmas - `corpusLemmas` of the corpus.
 * @returns One `kind: word` line per stale entry.
 */
export function staleEntries(data: DictionaryData, lemmas: ReadonlySet<string>): string[] {
  const out: string[] = []
  const check = (kind: string, words: readonly string[]): void => {
    for (const word of words) if (!lemmas.has(word.toLowerCase())) out.push(`${kind}: ${word}`)
  }
  check(
    "technical noun",
    data.technicalNouns.map((e) => e.word),
  )
  check(
    "technical verb",
    data.technicalVerbs.map((e) => e.word),
  )
  check(
    "compound",
    data.compounds.map((e) => e.word),
  )
  return out
}

/**
 * The label guard: every label that no surface names in a code
 * span. A label passes only inside a span, so an unused one is a hole.
 *
 * @param data - The dictionary data.
 * @returns One `label: word` line per stale entry.
 */
export function staleLabels(data: DictionaryData): string[] {
  const texts = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)].map((s) => s.text)
  return (data.labels ?? [])
    .filter((e) => !texts.some((t) => t.includes(`\`${e.word}\``)))
    .map((e) => `label: ${e.word}`)
}

/**
 * `pending.json` as file text, in the shape biome formats (line width 100): a
 * `files` array that fits on its line stays on one line. So the writer output
 * passes `biome check` with no extra step.
 *
 * @param entries - The pending entries.
 * @returns The file text.
 */
export function pendingText(entries: readonly PendingEntry[]): string {
  const lines = ["["]
  entries.forEach((entry, i) => {
    const comma = i < entries.length - 1 ? "," : ""
    const word = `    "word": ${JSON.stringify(entry.word)},`
    const oneLine = `    "files": [${entry.files.map((f) => JSON.stringify(f)).join(", ")}]`
    lines.push("  {", word)
    if (oneLine.length <= 100) lines.push(oneLine)
    else {
      lines.push('    "files": [')
      entry.files.forEach((f, j) => {
        lines.push(`      ${JSON.stringify(f)}${j < entry.files.length - 1 ? "," : ""}`)
      })
      lines.push("    ]")
    }
    lines.push(`  }${comma}`)
  })
  lines.push("]")
  return `${lines.join("\n")}\n`
}

/**
 * The pending guard: every pending (word, file) pair that no longer fails in
 * that file. The fix removed the debt, so the entry must go.
 *
 * @param pending - The committed pending list.
 * @param live - `computePending` of the tree, judged with no pending.
 * @returns One `word @ file` line per stale pair.
 */
export function stalePending(
  pending: readonly PendingEntry[],
  live: readonly PendingEntry[],
): string[] {
  const have = new Set(live.flatMap((e) => e.files.map((file) => `${e.word}@${file}`)))
  return pending.flatMap((e) =>
    e.files.filter((file) => !have.has(`${e.word}@${file}`)).map((file) => `${e.word} @ ${file}`),
  )
}

/** One failing word occurrence. */
export interface Miss {
  token: CorpusToken
  reason: "unapproved" | "unknown"
  use?: string
}

/**
 * Every corpus token that the dictionary rejects, before pending.
 *
 * @param tokens - The corpus tokens.
 * @param dict - The dictionary.
 * @returns One entry per failing occurrence.
 */
export function corpusMisses(tokens: readonly CorpusToken[], dict: Dictionary): Miss[] {
  const out: Miss[] = []
  for (const token of tokens) {
    const verdict = dict.check(token.word)
    if (verdict.ok) continue
    out.push(
      verdict.reason === "unapproved"
        ? { token, reason: "unapproved", use: verdict.use }
        : { token, reason: "unknown" },
    )
  }
  return out
}

/**
 * The pending list the tree needs today: every prose-role word that fails,
 * with its files.
 *
 * @param misses - The corpus misses.
 * @returns Pending entries, sorted by word, files sorted.
 */
export function computePending(misses: readonly Miss[]): PendingEntry[] {
  const byWord = new Map<string, Set<string>>()
  for (const miss of misses) {
    if (miss.token.role !== "prose") continue
    const files = byWord.get(miss.token.form) ?? new Set<string>()
    files.add(miss.token.file)
    byWord.set(miss.token.form, files)
  }
  return [...byWord.entries()]
    .map(([word, files]) => ({ word, files: [...files].sort() }))
    .sort((a, b) => compareWords(a.word, b.word))
}

/**
 * The occurrence count of each pending pair: `"<word> @ <file>": count`, for
 * every prose-role miss. These are the counts that the lock pins, so one
 * more use of a pending word in its own file is a raise.
 *
 * @param misses - The corpus misses.
 * @returns The counts.
 */
export function pendingCounts(misses: readonly Miss[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const miss of misses) {
    if (miss.token.role !== "prose") continue
    const key = lockKey(miss.token.form, miss.token.file)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

/**
 * The pending counts that the tree needs today. The dictionary check does
 * not read pending, so every miss counts.
 *
 * @returns `"<word> @ <file>": count` for the whole corpus.
 */
export function livePendingCounts(): Record<string, number> {
  return pendingCounts(corpusMisses(corpusTokens(), loadDictionary({ dir: DICTIONARY_DIR })))
}

/** The pending list as a set of `"<word> @ <file>"` keys. */
export function pendingKeys(pending: readonly PendingEntry[]): string[] {
  return pending.flatMap((e) => e.files.map((file) => lockKey(e.word, file)))
}

/** The sort order of every dictionary file: plain code-unit order of the word. */
export function compareWords(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** One entry of the local reference dictionary. */
export interface ReferenceEntry {
  word: string
  part_of_speech: string
  approved: boolean
  alternatives?: string[]
}

/** The reference, indexed by word. */
export interface Reference {
  path: string
  approved: Map<string, Set<Pos>>
  unapproved: Map<string, Set<Pos>>
  alternatives: Map<string, string[]>
}

const POS_NAMES: Readonly<Record<string, Pos>> = {
  noun: "n",
  verb: "v",
  adjective: "adj",
  adverb: "adv",
  pronoun: "pron",
  article: "art",
  preposition: "prep",
  conjunction: "conj",
}

/** The reference path: env `STE_REFERENCE`, or the default local copy. */
export function referencePath(): string {
  return process.env.STE_REFERENCE ?? join(homedir(), ".minimal-agent/ste/ste100-issue9.json")
}

/**
 * Corrections to the extracted reference, each checked by hand against the
 * Issue 9 PDF. The extraction drops some uppercase headwords that wrap in the
 * PDF table. Headword and part of speech only.
 */
export const REFERENCE_CORRECTIONS: ReadonlyArray<{ word: string; pos: Pos; approved: boolean }> = [
  { word: "able", pos: "adj", approved: false },
  { word: "adjustable", pos: "adj", approved: true },
  { word: "applicable", pos: "adj", approved: true },
  { word: "clockwise", pos: "adv", approved: true },
  { word: "compatible", pos: "adj", approved: true },
  { word: "continuous", pos: "adj", approved: true },
  { word: "counterclockwise", pos: "adv", approved: true },
  { word: "dangerous", pos: "adj", approved: true },
  { word: "electronic", pos: "adj", approved: true },
  { word: "equivalent", pos: "adj", approved: true },
  { word: "gradually", pos: "adv", approved: true },
  { word: "horizontal", pos: "adj", approved: true },
  { word: "installation", pos: "n", approved: true },
  { word: "internally", pos: "adv", approved: true },
  { word: "maintenance", pos: "n", approved: true },
  { word: "malfunction", pos: "n", approved: true },
  { word: "mandatory", pos: "adj", approved: true },
  { word: "mechanical", pos: "adj", approved: true },
  { word: "previously", pos: "adv", approved: true },
  { word: "regularly", pos: "adv", approved: true },
  { word: "secondary", pos: "adj", approved: true },
  { word: "temporary", pos: "adj", approved: true },
  { word: "unusually", pos: "adv", approved: true },
  { word: "vertically", pos: "adv", approved: true },
]

/**
 * Load the local reference dictionary, with the hand-checked corrections.
 *
 * @param path - The reference JSON.
 * @returns The reference, or undefined when the file does not exist.
 */
export function loadReference(path: string = referencePath()): Reference | undefined {
  if (!existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: ReferenceEntry[] }
  const approved = new Map<string, Set<Pos>>()
  const unapproved = new Map<string, Set<Pos>>()
  const alternatives = new Map<string, string[]>()
  const put = (map: Map<string, Set<Pos>>, word: string, pos: Pos): void => {
    const set = map.get(word) ?? new Set<Pos>()
    set.add(pos)
    map.set(word, set)
  }
  for (const entry of raw.entries) {
    const pos = POS_NAMES[entry.part_of_speech]
    if (!pos) continue
    const word = entry.word.toLowerCase()
    put(entry.approved ? approved : unapproved, word, pos)
    if (!entry.approved && entry.alternatives) {
      alternatives.set(`${word}|${pos}`, entry.alternatives)
    }
  }
  for (const fix of REFERENCE_CORRECTIONS) {
    const from = fix.approved ? unapproved : approved
    from.get(fix.word)?.delete(fix.pos)
    put(fix.approved ? approved : unapproved, fix.word, fix.pos)
  }
  return { path, approved, unapproved, alternatives }
}

/**
 * Check the word lists against the reference. Every problem is one line.
 *
 * - every general entry is approved in the reference for that word and pos
 * - every unapproved entry is unapproved in the reference for that word and pos
 * - a TN or TV entry that is an approved reference word is redundant (TN: as a
 *   noun, TV: as a verb)
 *
 * @param data - The dictionary data.
 * @param ref - The reference.
 * @returns The problems. Empty means the lists agree with the reference.
 */
export function verifyAgainstReference(data: DictionaryData, ref: Reference): string[] {
  const problems: string[] = []
  for (const entry of data.general) {
    if (!ref.approved.get(entry.word)?.has(entry.pos)) {
      problems.push(`general: "${entry.word}" (${entry.pos}) is not approved in the reference`)
    }
  }
  for (const entry of data.unapproved) {
    if (!ref.unapproved.get(entry.word)?.has(entry.pos)) {
      problems.push(
        `unapproved: "${entry.word}" (${entry.pos}) is not an unapproved reference word`,
      )
    }
  }
  for (const entry of data.technicalNouns) {
    if (ref.approved.get(entry.word.toLowerCase())?.has("n")) {
      problems.push(`technical noun: "${entry.word}" is an approved noun, so it is redundant`)
    }
  }
  for (const entry of data.technicalVerbs) {
    if (ref.approved.get(entry.word.toLowerCase())?.has("v")) {
      problems.push(`technical verb: "${entry.word}" is an approved verb, so it is redundant`)
    }
  }
  return problems
}

export { pendingAdditions }

/** Parse the value after a flag. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** `--unknown`: list the failing words with counts and locations. */
function unknownMode(args: readonly string[]): number {
  const role = flagValue(args, "--role")
  const file = flagValue(args, "--file")
  const dict = loadDictionary()
  const misses = corpusMisses(corpusTokens(), dict).filter(
    (miss) => (!role || miss.token.role === role) && (!file || miss.token.file === file),
  )
  const byWord = new Map<string, Miss[]>()
  for (const miss of misses) {
    const list = byWord.get(miss.token.form) ?? []
    list.push(miss)
    byWord.set(miss.token.form, list)
  }
  const rows = [...byWord.entries()].sort(
    (a, b) => b[1].length - a[1].length || compareWords(a[0], b[0]),
  )
  for (const [word, list] of rows) {
    const first = list[0]
    const kind = first?.reason === "unapproved" ? `unapproved, use "${first.use}"` : "unknown"
    console.log(`${String(list.length).padStart(4)}  ${word}  (${kind})`)
    const places = [
      ...new Set(list.map((m) => `${m.token.file}:${m.token.line} ${m.token.locator}`)),
    ]
    for (const place of places.slice(0, 5)) console.log(`        ${place}`)
    if (places.length > 5) console.log(`        ... ${places.length - 5} more`)
  }
  console.log(`\n${rows.length} distinct words, ${misses.length} occurrences`)
  return 0
}

/** `--write-pending`: regenerate pending, never above the lock. */
function writePendingMode(): number {
  const dict = loadDictionary({ dir: DICTIONARY_DIR })
  // Judge the tree with NO pending, so the list is what the tree needs.
  const misses = corpusMisses(corpusTokens(), dict)
  const next = computePending(misses)
  const counts = pendingCounts(misses)
  let working: ReturnType<typeof readLock>
  try {
    working = readLock(LOCK_PATH)
  } catch (error) {
    console.error(
      `ste:dict: cannot read ${LOCK_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    )
    console.error("  The lock is the ceiling of pending.json. Restore it from git.")
    return 2
  }
  // The ceiling is the lowest of the working lock and every committed copy,
  // so a hand raise of the lock file does not raise the ceiling.
  const ceiling = lockCeiling(working, lockHistory())
  const added = pendingAdditions(counts, ceiling.pending)
  if (added.length > 0) {
    console.error("ste:dict: refusing to raise the pending debt above the lock (rewrite the text):")
    for (const line of added) console.error(`  ${line}`)
    return 1
  }
  writeFileSync(join(DICTIONARY_DIR, "pending.json"), pendingText(next))
  writeLock({ ...ceiling, pending: counts })
  const files = new Set(next.flatMap((entry) => entry.files))
  const uses = Object.values(counts).reduce((sum, n) => sum + n, 0)
  console.log(
    `ste:dict: wrote ${next.length} pending words over ${files.size} files (${uses} uses), and the lock`,
  )
  return 0
}

/** `--verify`: compare the lists with the local reference. */
function verifyMode(): number {
  const ref = loadReference()
  if (!ref) {
    console.log(`ste:dict: no reference dictionary at ${referencePath()}, skipped`)
    return 0
  }
  const problems = verifyAgainstReference(readDictionaryData(), ref)
  for (const problem of problems) console.error(problem)
  console.log(`ste:dict: ${problems.length} problems against ${ref.path}`)
  return problems.length === 0 ? 0 : 1
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let code = 2
  if (args.includes("--unknown")) code = unknownMode(args)
  else if (args.includes("--write-pending")) code = writePendingMode()
  else if (args.includes("--verify")) code = verifyMode()
  else
    console.error(
      "usage: ste-dict.ts --unknown [--role tool|param|prose] [--file x] | --write-pending | --verify",
    )
  process.exit(code)
}
