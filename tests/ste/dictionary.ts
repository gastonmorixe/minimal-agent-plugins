/**
 * ASD-STE100 rule 1.1 for model-facing text: every prose word is an approved
 * dictionary word, a project technical noun (TN, rule 1.5) or a project
 * technical verb (TV, rule 1.12). Everything else is a `ste-s19-dictionary`
 * finding.
 *
 * The word lists in `tests/ste/dictionary/` are project-authored: a headword,
 * its part of speech, and for TN, TV and compound entries a short reason in
 * our own words. No ASD-STE100 definition or example text is in this repo.
 * The full reference dictionary is local only (see `ste-dictionary.test.ts`).
 *
 * Files:
 *
 * - `general.json`: approved general words we use, `{word, pos}`.
 * - `unapproved.json`: our fix map, `{word, pos, use}`. These are rewrite
 *   targets, not approvals.
 * - `technical-nouns.json` and every `tn-<area>.json`: `{word, category, reason}`.
 * - `technical-verbs.json`: `{word, category, reason}`.
 * - `compounds.json`: hyphenated words that pass as one item, `{word, reason}`.
 * - `irregular.json`: `{form: lemma}`, for the forms the suffix rules miss.
 * - `pending.json`: prose-role debt, `{word, files}`. A new word or a new file
 *   is blocked.
 *
 * @module tests/ste/dictionary
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { SteFinding } from "./ste-rules.ts"

/** Part of speech, as the dictionary files record it. */
export type Pos = "n" | "v" | "adj" | "adv" | "pron" | "art" | "prep" | "conj" | "num"

/** The verdict for one word form. */
export type WordVerdict =
  | { ok: true; via: "general" | "tn" | "tv" | "compound" | "auto" }
  | { ok: false; reason: "unapproved"; use: string }
  | { ok: false; reason: "unknown" }

/** A loaded dictionary. */
export interface Dictionary {
  check(word: string): WordVerdict
  /** base-form verbs (general v + TV), for isInstruction */
  isVerb(word: string): boolean
  pending(file: string): ReadonlySet<string>
}

/** How a form relates to its lemma. `irr` comes from `irregular.json`. */
export type Inflection = "base" | "s" | "poss" | "ed" | "ing" | "er" | "est" | "ly" | "irr"

/** One general entry. */
export interface GeneralEntry {
  word: string
  pos: Pos
}

/** One unapproved entry: the word, its part of speech, and the approved words to use. */
export interface UnapprovedEntry {
  word: string
  pos: Pos
  use: string
}

/** One technical noun (rule 1.5 category 1-22) or verb (rule 1.12 category "2a", "2b", "2c"). */
export interface TechnicalEntry {
  word: string
  category: number | string
  reason: string
}

/** One compound. */
export interface CompoundEntry {
  word: string
  reason: string
}

/** One pending word with the prose files that still use it. */
export interface PendingEntry {
  word: string
  files: string[]
}

/** The raw data of the dictionary folder. */
export interface DictionaryData {
  general: GeneralEntry[]
  unapproved: UnapprovedEntry[]
  technicalNouns: TechnicalEntry[]
  technicalVerbs: TechnicalEntry[]
  compounds: CompoundEntry[]
  irregular: Record<string, string>
  pending: PendingEntry[]
}

/** The plugins repo root: two levels up from this file. */
const ROOT = resolve(import.meta.dir, "..", "..")

/** The dictionary folder. */
export const DICTIONARY_DIR = join(import.meta.dir, "dictionary")

/** The golden with the widest `tools[]` (built-in tools plus the plugin tools). */
export const GOLDEN_PATH = join(ROOT, "tests/request-golden/goldens/plugin-handler-throws.json")

/** Rule id of the finding. */
export const DICTIONARY_RULE = "ste-s19-dictionary"

/**
 * The inflections each part of speech accepts (R3 section 7.2).
 *
 * STE gives each approved verb four forms: base, -s, past and past participle
 * (rule 3.1). The -ing form is not one of them (rule 3.5), so `ing` is not in
 * the verb or TV set: `using` is a finding with the message "use (no -ing
 * form)", and the few approved -ing words (`missing`, `remaining`, `during`,
 * `opening`) are their own entries. An -ly adverb must be its own entry,
 * because STE approves some adverbs and not others.
 */
const VALID: Readonly<Record<string, ReadonlySet<Inflection>>> = {
  n: new Set(["base", "s", "poss", "irr"]),
  v: new Set(["base", "s", "ed", "irr"]),
  adj: new Set(["base", "er", "est", "irr"]),
  adv: new Set(["base"]),
  pron: new Set(["base"]),
  art: new Set(["base"]),
  prep: new Set(["base"]),
  conj: new Set(["base"]),
  num: new Set(["base"]),
  tn: new Set(["base", "s", "poss", "irr"]),
  tv: new Set(["base", "s", "ed", "irr"]),
  compound: new Set(["base", "s", "poss"]),
}

/**
 * The inflections that identify a form of an UNAPPROVED word. A verb in -ing
 * points to its entry (`creating` gives "make"), and an adverb in -ly points
 * to its adjective entry (`entirely` gives "full, all").
 */
const UNAPPROVED_FORMS: Readonly<Record<string, ReadonlySet<Inflection>>> = {
  ...VALID,
  v: new Set(["base", "s", "ed", "ing", "irr"]),
  adj: new Set(["base", "er", "est", "ly", "irr"]),
}

/** The `use` text for the -ing form of an approved verb or a TV. */
export function ingUse(lemma: string): string {
  return `${lemma} (no -ing form)`
}

/** The default irregular map, used when no `irregular.json` is given to `lemmaCandidates`. */
let defaultIrregular: Record<string, string> | undefined

/** Read the committed `irregular.json` once. */
function committedIrregular(): Record<string, string> {
  if (defaultIrregular) return defaultIrregular
  const path = join(DICTIONARY_DIR, "irregular.json")
  defaultIrregular = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)
    : {}
  return defaultIrregular
}

/** True when the last two letters are the same consonant (`stopp`, `runn`). */
function doubled(stem: string): boolean {
  const a = stem.at(-1)
  const b = stem.at(-2)
  return a !== undefined && a === b && !"aeiouy".includes(a)
}

/**
 * Every lemma a word form can come from, with its inflection.
 *
 * The rules are suffix rules with no NLP library. They return EVERY candidate,
 * and the dictionary accepts the form when ANY candidate is valid for an
 * entry. A wrong candidate (`basical` for `basically`) is harmless, because it
 * is never an entry.
 *
 * @param form - One token, any case.
 * @param irregular - Irregular forms. Defaults to the committed `irregular.json`.
 * @returns The candidates, the form itself first, without duplicates.
 */
export function lemmaCandidates(
  form: string,
  irregular: Readonly<Record<string, string>> = committedIrregular(),
): Array<{ lemma: string; inflection: Inflection }> {
  const out: Array<{ lemma: string; inflection: Inflection }> = []
  const seen = new Set<string>()
  const add = (lemma: string, inflection: Inflection): void => {
    if (lemma.length === 0) return
    const key = `${lemma}|${inflection}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ lemma, inflection })
  }
  const f = form.toLowerCase().replace(/[\u2019\u02bc]/g, "'")

  if (f.endsWith("'s") && f.length > 2) {
    add(f.slice(0, -2), "poss")
    return out
  }
  if (f.endsWith("s'") && f.length > 2) {
    // A plural possessive: `files'` -> `file`.
    for (const c of lemmaCandidates(f.slice(0, -1), irregular)) {
      if (c.inflection === "s" || c.inflection === "irr") add(c.lemma, "poss")
    }
    return out
  }

  add(f, "base")
  const irr = irregular[f]
  if (irr !== undefined) add(irr, "irr")

  // -s: queries -> query, boxes -> box, goes -> go, files -> file.
  if (f.length > 3 && f.endsWith("ies")) add(`${f.slice(0, -3)}y`, "s")
  if (/(?:s|x|z|ch|sh|o)es$/.test(f) && f.length > 3) add(f.slice(0, -2), "s")
  if (f.length > 2 && f.endsWith("s") && !/(?:ss|us|is)$/.test(f)) add(f.slice(0, -1), "s")

  // -ed: copied -> copy, used -> use, stopped -> stop.
  if (f.length > 3 && f.endsWith("ied")) add(`${f.slice(0, -3)}y`, "ed")
  if (f.length > 3 && f.endsWith("ed")) {
    const stem = f.slice(0, -2)
    add(stem, "ed")
    add(f.slice(0, -1), "ed")
    if (doubled(stem)) add(stem.slice(0, -1), "ed")
  }

  // -ing: making -> make, running -> run, dying -> die.
  if (f.length > 4 && f.endsWith("ing")) {
    const stem = f.slice(0, -3)
    add(stem, "ing")
    add(`${stem}e`, "ing")
    if (doubled(stem)) add(stem.slice(0, -1), "ing")
    if (f.endsWith("ying")) add(`${f.slice(0, -4)}ie`, "ing")
  }

  // -er and -est: larger -> large, easiest -> easy, bigger -> big.
  for (const suffix of ["est", "er"] as const) {
    if (f.length <= suffix.length + 2 || !f.endsWith(suffix)) continue
    const stem = f.slice(0, -suffix.length)
    if (stem.endsWith("i")) add(`${stem.slice(0, -1)}y`, suffix)
    add(stem, suffix)
    add(`${stem}e`, suffix)
    if (doubled(stem)) add(stem.slice(0, -1), suffix)
  }

  // -ly: easily -> easy, basically -> basical, fully -> full, quickly -> quick.
  if (f.length > 4 && f.endsWith("ly")) {
    if (f.endsWith("ily")) add(`${f.slice(0, -3)}y`, "ly")
    if (f.endsWith("ally")) add(f.slice(0, -2), "ly")
    if (f.endsWith("lly")) add(f.slice(0, -1), "ly")
    add(f.slice(0, -2), "ly")
  }
  return out
}

/** Read one JSON file of the dictionary folder, or a fallback when it is absent. */
function readJson<T>(dir: string, name: string, fallback: T): T {
  const path = join(dir, name)
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, "utf8")) as T
}

/**
 * Read the dictionary folder. Every `tn-<area>.json` merges into the TN list.
 *
 * @param dir - The dictionary folder.
 * @returns The raw data.
 */
export function readDictionaryData(dir: string = DICTIONARY_DIR): DictionaryData {
  const technicalNouns = readJson<TechnicalEntry[]>(dir, "technical-nouns.json", [])
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (/^tn-[a-z0-9-]+\.json$/.test(name)) {
        technicalNouns.push(...readJson<TechnicalEntry[]>(dir, name, []))
      }
    }
  }
  return {
    general: readJson<GeneralEntry[]>(dir, "general.json", []),
    unapproved: readJson<UnapprovedEntry[]>(dir, "unapproved.json", []),
    technicalNouns,
    technicalVerbs: readJson<TechnicalEntry[]>(dir, "technical-verbs.json", []),
    compounds: readJson<CompoundEntry[]>(dir, "compounds.json", []),
    irregular: readJson<Record<string, string>>(dir, "irregular.json", {}),
    pending: readJson<PendingEntry[]>(dir, "pending.json", []),
  }
}

/** Walk a JSON value and collect tool names, schema property keys and enum values. */
function collectSchemaNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaNames(item, out)
    return
  }
  if (!node || typeof node !== "object") return
  const record = node as Record<string, unknown>
  if (record.properties && typeof record.properties === "object") {
    for (const key of Object.keys(record.properties as object)) out.add(key)
  }
  if (Array.isArray(record.enum)) {
    for (const value of record.enum) if (typeof value === "string") out.add(value)
  }
  for (const child of Object.values(record)) collectSchemaNames(child, out)
}

/** Find the first `tools` array in a golden request. */
function findTools(node: unknown): unknown[] | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTools(item)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== "object") return undefined
  const record = node as Record<string, unknown>
  if (Array.isArray(record.tools)) return record.tools
  for (const child of Object.values(record)) {
    const found = findTools(child)
    if (found) return found
  }
  return undefined
}

/**
 * The default auto technical nouns: the wire tool names, every input_schema
 * property key and enum value in the golden `tools[]`, every plugin folder and
 * plugin `name`, the manifest tool names and aliases, and the slash command
 * names.
 *
 * @param root - Plugins repo root.
 * @returns The names, as written.
 */
export function defaultAutoTechNouns(root: string = ROOT): Set<string> {
  const out = new Set<string>()
  const golden = join(root, "tests/request-golden/goldens/plugin-handler-throws.json")
  if (existsSync(golden)) {
    const tools = findTools(JSON.parse(readFileSync(golden, "utf8")) as unknown) ?? []
    for (const tool of tools) {
      const record = tool as Record<string, unknown>
      if (typeof record.name === "string") out.add(record.name)
      collectSchemaNames(record.input_schema, out)
    }
  }
  for (const plugin of readdirSync(root)) {
    if (!plugin.startsWith("ma-")) continue
    out.add(plugin)
    const path = join(root, plugin, "manifest.json")
    if (!existsSync(path)) continue
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof manifest.name === "string") out.add(manifest.name)
    const headless = (manifest.headless ?? {}) as Record<string, unknown>
    for (const command of (headless.commands as Array<Record<string, unknown>>) ?? []) {
      if (typeof command.name === "string") out.add(command.name)
    }
    for (const entry of (headless.tools as Array<Record<string, unknown>>) ?? []) {
      const tool = ((entry.trigger as Record<string, unknown>)?.tool ?? {}) as Record<
        string,
        unknown
      >
      if (typeof tool.name === "string") out.add(tool.name)
      for (const alias of (tool.aliases as unknown[]) ?? []) {
        if (typeof alias === "string") out.add(alias)
      }
      collectSchemaNames(tool.input_schema, out)
    }
  }
  return out
}

/** A token with a capital after the first letter and a lowercase letter: `DevTools`, `IDs`. */
function isCamel(token: string): boolean {
  return /^.+[A-Z]/.test(token) && /[a-z]/.test(token)
}

/** Two or more capitals and no lowercase letter: `JSON`, `CDP`. */
function isAllCaps(token: string): boolean {
  return /^[A-Z][A-Z-]+$/.test(token)
}

/** Options for {@link loadDictionary}. */
export interface LoadDictionaryOptions {
  /** The dictionary folder. Default `tests/ste/dictionary`. */
  dir?: string
  /**
   * Names that pass as written, for example tool names, param keys and enum
   * values. Default `defaultAutoTechNouns()`.
   */
  autoTechNouns?: Iterable<string>
}

/**
 * Load the dictionary.
 *
 * @param opts - Where to read the data and which names pass as written.
 * @returns The dictionary.
 */
export function loadDictionary(opts?: LoadDictionaryOptions): Dictionary {
  const data = readDictionaryData(opts?.dir ?? DICTIONARY_DIR)
  return buildDictionary(data, opts?.autoTechNouns ?? defaultAutoTechNouns())
}

/**
 * Build a dictionary from data, without reading files. Tests use it to change
 * one entry at a time.
 *
 * @param data - The raw data.
 * @param autoTechNouns - Names that pass as written.
 * @returns The dictionary.
 */
export function buildDictionary(data: DictionaryData, autoTechNouns: Iterable<string>): Dictionary {
  /** For each lemma: the kinds that accept it (`n`, `v`, ..., `tn`, `tv`, `compound`). */
  const accept = new Map<string, Set<string>>()
  const mark = (word: string, kind: string): void => {
    const key = word.toLowerCase()
    const set = accept.get(key) ?? new Set<string>()
    set.add(kind)
    accept.set(key, set)
  }
  for (const entry of data.general) mark(entry.word, entry.pos)
  for (const entry of data.technicalNouns) mark(entry.word, "tn")
  for (const entry of data.technicalVerbs) mark(entry.word, "tv")
  for (const entry of data.compounds) mark(entry.word, "compound")

  const unapproved = new Map<string, UnapprovedEntry[]>()
  for (const entry of data.unapproved) {
    const list = unapproved.get(entry.word) ?? []
    list.push(entry)
    unapproved.set(entry.word, list)
  }

  // A plain lowercase key or enum value (`every`, `include`, `list`, `fleet`)
  // reads as an English word in prose, so it is judged as one: write it in a
  // code span when it is the name. Only a name with a capital, a hyphen, a
  // digit or `_` passes as written (`ScheduleCronList`, `clear-stale`).
  const auto = new Set<string>()
  for (const name of autoTechNouns) if (!/^[a-z]+$/.test(name)) auto.add(name)

  const pendingByFile = new Map<string, Set<string>>()
  for (const entry of data.pending) {
    for (const file of entry.files) {
      const set = pendingByFile.get(file) ?? new Set<string>()
      set.add(entry.word)
      pendingByFile.set(file, set)
    }
  }
  const empty: ReadonlySet<string> = new Set()

  const viaOf = (kind: string): "general" | "tn" | "tv" | "compound" => {
    if (kind === "tn" || kind === "tv" || kind === "compound") return kind
    return "general"
  }

  /** Accept a form when any candidate lemma is valid for an entry kind. */
  const lookup = (
    token: string,
    kinds: (kind: string) => boolean,
  ): "general" | "tn" | "tv" | "compound" | undefined => {
    for (const candidate of lemmaCandidates(token, data.irregular)) {
      const have = accept.get(candidate.lemma)
      if (!have) continue
      for (const kind of have) {
        if (kinds(kind) && VALID[kind]?.has(candidate.inflection)) return viaOf(kind)
      }
    }
    return undefined
  }

  const anyKind = (): boolean => true
  const nounOnly = (kind: string): boolean => kind === "tn" || kind === "compound"

  const checkSimple = (token: string): WordVerdict => {
    if (/[0-9_]/.test(token)) return { ok: true, via: "auto" }
    if (auto.has(token)) return { ok: true, via: "auto" }
    if (isCamel(token)) {
      // `DevTools`, `JavaScript`: a name, so only a TN entry passes it.
      const via = lookup(token, nounOnly)
      return via ? { ok: true, via } : { ok: false, reason: "unknown" }
    }
    if (isAllCaps(token)) {
      const via = lookup(token, nounOnly)
      if (via) return { ok: true, via }
    }
    const via = lookup(token, anyKind)
    if (via) return { ok: true, via }
    const candidates = lemmaCandidates(token, data.irregular)
    // The first candidate lemma with an unapproved entry gives the fix. When
    // it has entries for more than one part of speech (`return` n and v), the
    // message joins their `use` words, because the word alone does not tell
    // which one the writer meant.
    for (const candidate of candidates) {
      const uses: string[] = []
      for (const entry of unapproved.get(candidate.lemma) ?? []) {
        if (!UNAPPROVED_FORMS[entry.pos]?.has(candidate.inflection)) continue
        for (const use of entry.use.split(",")) {
          const word = use.trim()
          if (word && !uses.includes(word)) uses.push(word)
        }
      }
      if (uses.length > 0) return { ok: false, reason: "unapproved", use: uses.join(", ") }
    }
    // The -ing form of an approved verb or a TV (`using`, `running`).
    for (const candidate of candidates) {
      if (candidate.inflection !== "ing") continue
      const have = accept.get(candidate.lemma)
      if (have?.has("v") || have?.has("tv")) {
        return { ok: false, reason: "unapproved", use: ingUse(candidate.lemma) }
      }
    }
    return { ok: false, reason: "unknown" }
  }

  const check = (word: string): WordVerdict => {
    if (!word.includes("-")) return checkSimple(word)
    if (auto.has(word)) return { ok: true, via: "auto" }
    for (const candidate of lemmaCandidates(word, data.irregular)) {
      if (
        accept.get(candidate.lemma)?.has("compound") &&
        VALID.compound?.has(candidate.inflection)
      ) {
        return { ok: true, via: "compound" }
      }
    }
    const parts = word.split("-").filter((part) => part.length > 0)
    if (parts.length === 0) return { ok: true, via: "auto" }
    if (parts.length > 3) return { ok: false, reason: "unknown" }
    let via: "general" | "tn" | "tv" | "compound" | "auto" = "general"
    for (const part of parts) {
      if (/^[0-9]+$/.test(part)) continue
      const verdict = checkSimple(part)
      if (!verdict.ok) {
        if (verdict.reason === "unapproved") {
          return { ok: false, reason: "unapproved", use: `${verdict.use} (for "${part}")` }
        }
        return verdict
      }
      if (via === "general") via = verdict.via
    }
    return { ok: true, via }
  }

  const isVerb = (word: string): boolean => {
    const have = accept.get(word.toLowerCase())
    return Boolean(have?.has("v") || have?.has("tv"))
  }

  return {
    check,
    isVerb,
    pending: (file: string) => pendingByFile.get(file) ?? empty,
  }
}

/** `'s` contractions that look like a possessive. `ste-s6-contraction` owns them. */
const CONTRACTION_S = new Set([
  "it's",
  "that's",
  "let's",
  "here's",
  "there's",
  "what's",
  "who's",
  "where's",
  "he's",
  "she's",
])

/** One prose token with its offset in the text. */
export interface Token {
  word: string
  index: number
}

/**
 * Tokenize masked prose. The masked text has the same length as the raw text,
 * and a masked span holds a `W` placeholder, so a token that differs from the
 * raw text at the same place is a placeholder and is skipped. A token with a
 * digit or `_` is an identifier and is skipped. A dotted token with short parts
 * (`e.g`, `i.e`) is a Latin abbreviation, which `ste-s14-abbreviation` owns.
 *
 * @param masked - Masked text.
 * @param raw - Raw text of the same length.
 * @returns The tokens to look up.
 */
export function tokenize(masked: string, raw: string): Token[] {
  const out: Token[] = []
  const re = /[A-Za-z0-9_]+(?:['\u2019.-][A-Za-z0-9_]+)*/g
  for (const match of masked.matchAll(re)) {
    const word = match[0]
    const index = match.index ?? 0
    if (raw.slice(index, index + word.length) !== word) continue
    if (/[0-9_]/.test(word)) continue
    // A dotted token is a file name, a domain, a method or a Latin
    // abbreviation (`SKILL.md`, `Network.enable`, `e.g`), never a prose word.
    // `ste-s14-abbreviation` owns the abbreviations.
    if (word.includes(".")) continue
    // One letter is a label (a key, a flag, an axis), not a word. `I` is a word.
    if (word.length === 1 && word !== "I") continue
    // A contraction is `ste-s6-contraction`. Only the possessive `'s` stays.
    if (/['\u2019]/.test(word) && !/['\u2019]s$/i.test(word)) continue
    if (CONTRACTION_S.has(word.toLowerCase().replace(/\u2019/g, "'"))) continue
    out.push({ word, index })
  }
  return out
}

/** The 1-based line of an offset. */
function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * Tokenize MASKED prose (same length as raw) and return s19 findings.
 *
 * In the prose role, a word in `pending(file)` is recorded debt and is not a
 * finding. The tool and param roles have no pending: every word is judged.
 *
 * @param masked - The masked text.
 * @param raw - The raw text.
 * @param lineOffset - Added to each 1-based line.
 * @param file - Repo-relative file, for pending.
 * @param role - The surface role.
 * @param dict - The dictionary.
 * @returns One finding per word occurrence that fails.
 */
export function dictionaryFindings(
  masked: string,
  raw: string,
  lineOffset: number,
  file: string,
  role: "tool" | "param" | "prose",
  dict: Dictionary,
): SteFinding[] {
  const findings: SteFinding[] = []
  const pending = role === "prose" ? dict.pending(file) : new Set<string>()
  for (const token of tokenize(masked, raw)) {
    const verdict = dict.check(token.word)
    if (verdict.ok) continue
    const word = token.word.toLowerCase().replace(/\u2019/g, "'")
    if (pending.has(word)) continue
    findings.push({
      rule: DICTIONARY_RULE,
      message:
        verdict.reason === "unapproved"
          ? `"${word}": not approved, use "${verdict.use}"`
          : `"${word}": unknown, rewrite it or add it to tests/ste/dictionary/`,
      snippet: token.word,
      line: lineAt(masked, token.index) + lineOffset,
      severity: "error",
      offset: token.index,
      role,
    })
  }
  return findings
}

/** The parts of a surface that decide its role. */
export interface RoleInput {
  /** Repo-relative file. */
  file: string
  /** Where the text sits in the file. */
  locator: string
  /** An explicit role. It wins when it is set. */
  role?: string
}

/**
 * The role of a surface, from its file and locator.
 *
 * - tool: a tool `description` (manifest `...trigger.tool.description`, or a
 *   `ma-core-tools-plugin/prompts/tools/*.md` file)
 * - param: a param description (`.input_schema.`, `PARAMS.`, the core
 *   tool-text and the core `binary` param)
 * - prose: everything else
 *
 * @param surface - The surface. An explicit `role` wins when it is set.
 * @returns The role.
 */
export function surfaceRole(surface: RoleInput): "tool" | "param" | "prose" {
  if (surface.role === "tool" || surface.role === "param" || surface.role === "prose") {
    return surface.role
  }
  if (surface.locator.endsWith(".trigger.tool.description")) return "tool"
  if (/^ma-core-tools-plugin\/prompts\/tools\/[^/]+\.md$/.test(surface.file)) return "tool"
  if (surface.locator.includes(".input_schema.") || surface.locator.includes("PARAMS.")) {
    return "param"
  }
  if (surface.file === "core/src/tools/binary-guard.ts") return "param"
  if (surface.file === "ma-core-tools-plugin/tool-text.ts") return "param"
  return "prose"
}
