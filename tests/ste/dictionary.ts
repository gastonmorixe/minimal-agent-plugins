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
  /**
   * True when the word is a known name as written: a tool name, a schema key
   * or enum value, a plugin or command name (every auto name, also the plain
   * lowercase ones). A one-word code span that is a name is not judged (M4).
   */
  isName(word: string): boolean
  pending(file: string): ReadonlySet<string>
  /**
   * Rule 1.7 (REVIEW-C M7): the fix text when `word` is the -s form of a
   * technical noun that is also a verb (an unapproved verb entry, or a TN
   * `verb` field), so the form can be a verb (`requests`, `logs`). Otherwise
   * undefined. The caller decides with the word before it ({@link Dictionary.isNounContext}).
   */
  tnVerbUse(word: string): string | undefined
  /**
   * True when a word before a noun makes the next word a noun: an article, a
   * determiner, a number, an adjective or a preposition (`the`, `3`, `each`,
   * `all`, `network` is NOT one: a noun adjunct is ambiguous with a subject).
   */
  isNounContext(word: string): boolean
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
  /**
   * TN only: the approved verbs to use when the -s form reads as a verb
   * (`log` gives "record, write"). Rule 1.7: a technical noun is never a verb.
   */
  verb?: string
}

/** One compound. */
export interface CompoundEntry {
  word: string
  reason: string
}

/**
 * One label: a lowercase value that a tool prints in its result, or accepts
 * as free text, and that the tool text names in a code span (the IntercomPeers
 * status `idle`, the Mailbox kind `claim`). It is not a schema key or enum
 * value, so `defaultAutoTechNouns` cannot see it. The entry names the source
 * file that defines the label, and a test checks that the file has the label
 * as a string literal.
 */
export interface LabelEntry {
  word: string
  /** Repo-relative path of the file that defines the label. */
  source: string
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
  /** Labels (`labels.json`). Optional so that old test data stays valid. */
  labels?: LabelEntry[]
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
  // Rule 1.7 (REVIEW-C M7): a TN is a noun only. `irr` is out, because the
  // irregular map holds verb forms (`led` -> `lead`, `built` -> `build`). The
  // irregular PLURALS of a TN pass by IRREGULAR_PLURALS below.
  tn: new Set(["base", "s", "poss"]),
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

/**
 * The irregular forms in `irregular.json` that are noun plurals. A TN accepts
 * these irregular forms only (`children`, `indices`), never a verb form
 * (`led`, `built`).
 */
export const IRREGULAR_PLURALS: ReadonlySet<string> = new Set([
  "analyses",
  "children",
  "criteria",
  "data",
  "indices",
  "men",
  "people",
  "women",
])

/**
 * Words before a noun that are not in `general.json` as an article or an
 * adjective but still mark a noun phrase: determiners and quantifiers.
 */
const DETERMINERS: ReadonlySet<string> = new Set(
  (
    "a an the this that these those each every all any some no many more most few fewer " +
    "both other another its their your our my his her which what whose several such same " +
    "two three four five six seven eight nine ten zero one"
  ).split(" "),
)

/** Words that open an object noun phrase after a verb (M7 verb shape). */
const OBJECT_START: ReadonlySet<string> = new Set(
  (
    "a an the this that these those each every all any some no its their your our my his her " +
    "it them him us me one two three several many more"
  ).split(" "),
)

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
    labels: readJson<LabelEntry[]>(dir, "labels.json", []),
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
  const names = new Set<string>()
  for (const name of autoTechNouns) {
    names.add(name)
    if (!/^[a-z]+$/.test(name)) auto.add(name)
  }
  // A label is a name only inside a code span (`spanWords`). In plain prose it
  // is still judged as a word.
  for (const entry of data.labels ?? []) names.add(entry.word)

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
        if (!kinds(kind)) continue
        if (VALID[kind]?.has(candidate.inflection)) return viaOf(kind)
        // A TN accepts an irregular plural (`children`), not a verb form (`led`).
        if (
          kind === "tn" &&
          candidate.inflection === "irr" &&
          IRREGULAR_PLURALS.has(token.toLowerCase())
        ) {
          return "tn"
        }
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
    // REVIEW-C M5: a join of 3 or more parts ("at-least-once",
    // "tokens-per-second") is a new term, not two approved words. Only a
    // `compounds.json` entry or an auto name passes it. A 2-part join passes
    // when each part passes (`read-only`); s5 judges a hyphen phrasal verb.
    if (parts.length > 2) return { ok: false, reason: "unknown" }
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

  /** The TN lemmas that are also verbs, with the approved verbs to use. */
  const tnVerbs = new Map<string, string>()
  for (const entry of data.technicalNouns) {
    const lemma = entry.word.toLowerCase()
    const verbEntry = (unapproved.get(lemma) ?? []).find((e) => e.pos === "v")
    const use = entry.verb ?? verbEntry?.use
    if (use) tnVerbs.set(lemma, use)
  }

  const tnVerbUse = (word: string): string | undefined => {
    if (word.includes("-") || word.includes("'")) return undefined
    const verdict = checkSimple(word)
    if (!verdict.ok || verdict.via !== "tn") return undefined
    for (const candidate of lemmaCandidates(word, data.irregular)) {
      if (candidate.inflection !== "s") continue
      // A general noun or verb entry for the same form wins: it is approved
      // in both readings.
      const use = tnVerbs.get(candidate.lemma)
      if (use !== undefined) return use
    }
    return undefined
  }

  const isNounContext = (word: string): boolean => {
    const lower = word.toLowerCase()
    if (/^[0-9]/.test(lower) || DETERMINERS.has(lower)) return true
    const have = accept.get(lower)
    return Boolean(have?.has("art") || have?.has("num") || have?.has("adj") || have?.has("prep"))
  }

  const isVerb = (word: string): boolean => {
    const have = accept.get(word.toLowerCase())
    return Boolean(have?.has("v") || have?.has("tv"))
  }

  return {
    check,
    isVerb,
    isName: (word: string) => names.has(word),
    tnVerbUse,
    isNounContext,
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
 * The word inside a contraction, or undefined when the token is not one.
 *
 * `ste-s6-contraction` owns the contraction itself. s19 still judges the word
 * in it, so a contraction cannot hide an unknown word ("Frobnicate'll stop."
 * gives s6 plus s19 for `frobnicate`). A possessive (`file's`, `files'`) is
 * not a contraction: the suffix rules judge it. The `'s` forms in
 * {@link CONTRACTION_S} are contractions (`it's` = `it is`).
 *
 * @param word - One token with an apostrophe (straight or curly).
 * @returns The stem to judge (`can't` gives `can`, `won't` gives `will`,
 *   `It'd` gives `It`), or undefined for a possessive or no apostrophe.
 */
export function contractionStem(word: string): string | undefined {
  const w = word.replace(/[\u2019\u02bc]/g, "'")
  if (!w.includes("'")) return undefined
  const lower = w.toLowerCase()
  if (/'s$|s'$/.test(lower) && !CONTRACTION_S.has(lower)) return undefined
  if (lower.endsWith("n't")) {
    const head = w.slice(0, -3)
    const special: Record<string, string> = { ca: "can", wo: "will", sha: "shall", ai: "is" }
    const mapped = special[head.toLowerCase()]
    if (mapped === undefined) return head
    return head.charAt(0) === head.charAt(0).toUpperCase()
      ? mapped.charAt(0).toUpperCase() + mapped.slice(1)
      : mapped
  }
  return w.slice(0, w.indexOf("'"))
}

/**
 * Tokenize masked prose. The masked text has the same length as the raw text,
 * and a masked span holds a `W` placeholder, so a token that differs from the
 * raw text at the same place is a placeholder and is skipped. A token with a
 * digit or `_` is an identifier and is skipped. A dotted token with short parts
 * (`e.g`, `i.e`) is a Latin abbreviation, which `ste-s14-abbreviation` owns.
 * A contraction gives its stem (see {@link contractionStem}), at the offset of
 * the contraction.
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
    // A contraction is `ste-s6-contraction`, but the word in it is still
    // judged (REVIEW-C M3): `It'd` gives `It`, `Frobnicate'll` gives
    // `Frobnicate`. A possessive stays whole.
    const stem = contractionStem(word)
    const judged = stem ?? word
    // One letter is a label (a key, a flag, an axis), not a word. `I` is a word.
    if (judged.length === 0 || (judged.length === 1 && judged !== "I")) continue
    out.push({ word: judged, index })
  }
  return out
}

/**
 * Lowercase words that are code when they stand alone in a code span: JSON
 * literals, shell commands and key names. A one-word span of one of these is
 * an identifier, not a prose word (M4).
 */
export const CODE_WORDS: ReadonlySet<string> = new Set(
  (
    "true false null undefined nan " +
    // Shell commands (the `COMMAND_START` list of ste-rules.ts, plus the ones
    // the tool text names).
    "git bun bunx npm npx pnpm yarn node deno cat grep head tail sed awk curl export kill " +
    "docker mkdir chmod ssh psql echo printf unset source bash zsh sleep find " +
    // Key names (keyboard input in the computer-use params).
    "alt ctrl cmd shift option return escape enter tab space backspace delete " +
    "home end pageup pagedown"
  ).split(" "),
)

/**
 * The one-word code spans that s19 judges (REVIEW-C M4).
 *
 * `maskNonProse` masks every span with no space as code, so "Give the
 * `awesome` file." would hide `awesome`. A span is judged as a word when it is
 * plain lowercase letters (no dot, slash, `_`, digit, hyphen or capital: those
 * are identifiers), 3 or more letters (a 1- or 2-letter span is a code, a
 * flag or a key: `cd`, `en`, `z`), not in {@link CODE_WORDS}, and not a known
 * name (`Dictionary.isName`: a tool name, a key, an enum value, a plugin or a
 * command name). So "`awesome`" fires and "`list`" (an enum value) stays quiet.
 *
 * @param masked - Masked text, the same length as `raw`.
 * @param raw - Raw text.
 * @param dict - The dictionary, for `isName`.
 * @returns One token per judged span, at the offset of the word.
 */
export function spanWords(masked: string, raw: string, dict: Dictionary): Token[] {
  const out: Token[] = []
  for (const match of raw.matchAll(/`([a-z]+)`/g)) {
    const at = match.index ?? 0
    // Only a span that the mask hid as code. A fence is blank, not `W`.
    if (masked[at] !== "W") continue
    const word = match[1] ?? ""
    if (word.length <= 2 || CODE_WORDS.has(word) || dict.isName(word)) continue
    out.push({ word, index: at + 1 })
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
 * Tokenize MASKED prose (same length as raw) and return s19 findings. The
 * one-word code spans are {@link spanWordFindings}.
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
  return judgeTokens(tokenize(masked, raw), masked, lineOffset, file, role, dict)
}

/**
 * s19 findings for the one-word code spans that read as a word
 * ({@link spanWords}, REVIEW-C M4). `extra-rules.ts` runs it next to
 * {@link dictionaryFindings}. Pending applies the same way.
 *
 * @param masked - The masked text.
 * @param raw - The raw text.
 * @param lineOffset - Added to each 1-based line.
 * @param file - Repo-relative file, for pending.
 * @param role - The surface role.
 * @param dict - The dictionary.
 * @returns One finding per span word that fails.
 */
export function spanWordFindings(
  masked: string,
  raw: string,
  lineOffset: number,
  file: string,
  role: "tool" | "param" | "prose",
  dict: Dictionary,
): SteFinding[] {
  return judgeTokens(spanWords(masked, raw, dict), masked, lineOffset, file, role, dict)
}

/** Judge each token and build the s19 findings. */
function judgeTokens(
  tokens: readonly Token[],
  masked: string,
  lineOffset: number,
  file: string,
  role: "tool" | "param" | "prose",
  dict: Dictionary,
): SteFinding[] {
  const findings: SteFinding[] = []
  const pending = role === "prose" ? dict.pending(file) : new Set<string>()
  for (const token of tokens) {
    let verdict = dict.check(token.word)
    if (verdict.ok) {
      // Rule 1.7 (REVIEW-C M7): the -s form of a TN that is also a verb
      // (`requests`, `logs`) is judged as the VERB when it has the verb
      // shape: the next word opens an object noun phrase (an article, a
      // determiner, a number or an object pronoun: "requests a token", "logs
      // every action", "Builds the request"), and the word before does not
      // mark a noun phrase (an article, a determiner, a number, an adjective
      // or a preposition: "the requests", "3 logs"). Only spaces may sit
      // between the words. Every other shape reads as the plural noun ("logs
      // of network requests and responses", "examine logs.", "builds, tests").
      // The heuristic misses a verb with a bare-noun object ("logs errors"):
      // review owns that case.
      const use = dict.tnVerbUse(token.word)
      if (use === undefined) continue
      const end = token.index + token.word.length
      const after = /^[ \t]+([A-Za-z0-9']+)/.exec(masked.slice(end))?.[1]
      if (
        after === undefined ||
        (!OBJECT_START.has(after.toLowerCase()) && !/^[0-9]/.test(after))
      ) {
        continue
      }
      const before = /([A-Za-z0-9']+)[ \t]+$/.exec(masked.slice(0, token.index))?.[1]
      if (before !== undefined && dict.isNounContext(before)) continue
      verdict = {
        ok: false,
        reason: "unapproved",
        use: `${use} (a technical noun is not a verb, STE 1.7)`,
      }
    }
    const word = token.word.toLowerCase().replace(/\u2019/g, "'")
    if (pending.has(word)) continue
    findings.push({
      rule: DICTIONARY_RULE,
      message:
        verdict.reason === "unapproved"
          ? `"${word}": not approved, use "${verdict.use}"`
          : word.split("-").filter(Boolean).length > 2
            ? `"${word}": a join of 3 or more parts is a new term, rewrite it or add it to tests/ste/dictionary/compounds.json`
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
