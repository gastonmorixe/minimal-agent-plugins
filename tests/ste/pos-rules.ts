/**
 * s23: part of speech (ASD-STE100 rules 1.2, 1.7, 1.13) and meaning traps (1.3).
 *
 * The s19 dictionary check judges the lemma. It accepts "the record" because
 * RECORD is approved, but RECORD is approved only as a verb. This rule judges
 * the part of speech from a short window of words before it (no parser):
 *
 * - NOUN USE: a word that is approved ONLY as a verb (general.json `v`, or a
 *   technical verb) after a determiner or an article ("the record", "a lock",
 *   "each run"), also with adjectives between ("the full read", "a correct
 *   read"), and after a number ("two reads", "2 reads"), a possessive ("the
 *   file's read") or some/any/our/my/his/her/these/those. A technical noun
 *   with the same spelling is exempt: it may stand after a determiner (rule
 *   1.5).
 * - VERB USE: a word that is approved ONLY as a noun or an adjective after
 *   "to", a modal ("can", "must", "will", "cannot"), a modal + "not" ("must
 *   not test"), a subject pronoun (you, we, they), a modal or subject + one
 *   adverb ("can quickly test"), or an adverb that starts an order ("Then
 *   test"). A technical noun that is not an approved verb is a finding after
 *   the same openers, except "to" (a preposition too: "Write it to disk") and
 *   a sentence-start adverb ("You cannot file the result.").
 * - -S VERB: a noun-only lemma in its -s form after "it", "he", "she" or
 *   "this" ("It tests the file."). "The tool files" stays quiet: it can be a
 *   compound noun.
 *
 * Meaning traps catch an approved word in a meaning that STE does not approve
 * (rule 1.3), where the spelling alone cannot tell.
 *
 * A word inside a code span is masked before this rule runs, so `list` as an
 * enum value never reaches it.
 *
 * @module tests/ste/pos-rules
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { DICTIONARY_DIR, lemmaCandidates } from "./dictionary.ts"
import type { ExtraFindingsArgs, SteFinding } from "./ste-rules.ts"

/** Stable rule id. */
export const POS_RULE = "ste-s23-pos"

/**
 * Words that open a noun phrase: after one of these, the next word is a noun
 * or an adjective. "that", "this", "these", "those" and "one" are left out:
 * they are also pronouns or numbers ("a job that runs", "This is ...", "one
 * saved prompt"), and a bigram cannot tell them apart.
 */
const DETERMINERS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "each",
  "every",
  "its",
  "your",
  "their",
  "no",
])

/** Irregular past participles that STE 3.3 allows as adjectives ("a cut line"). */
const PARTICIPLES: ReadonlySet<string> = new Set([
  "cut",
  "set",
  "put",
  "found",
  "kept",
  "held",
  "made",
  "shown",
  "given",
  "written",
  "built",
  "sent",
  "lost",
  "done",
])

/**
 * More words that open a noun phrase, judged only for the noun-use check.
 * "this" and "that" stay out: they are also pronouns ("This is ...").
 */
const MORE_DETERMINERS: ReadonlySet<string> = new Set([
  "some",
  "any",
  "our",
  "my",
  "his",
  "her",
  "these",
  "those",
])

/**
 * Number words that open a noun phrase ("two reads"). "one" stays out: it is
 * also a pronoun ("the one that runs"). A digit token is a number too.
 */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
])

/** A possessive with `'s` that is not a contraction ("it's", "let's"). */
const NOT_POSSESSIVE: ReadonlySet<string> = new Set([
  "it",
  "that",
  "there",
  "here",
  "what",
  "who",
  "where",
  "how",
  "let",
  "he",
  "she",
])

/** Words after which the next word is a verb in its base form. */
const VERB_OPENERS: ReadonlySet<string> = new Set(["to", "can", "must", "will", "cannot"])

/** Modals: "not" after one of these (or after do/does) opens a verb. */
const MODALS: ReadonlySet<string> = new Set(["can", "must", "will", "cannot", "do", "does"])

/**
 * Subject pronouns: the next word is a verb. "it" stays out of this set: it is
 * often an object ("Give it values"). "i" stays out too.
 */
const SUBJECTS: ReadonlySet<string> = new Set(["you", "we", "they"])

/** Verb forms that are never a noun: a form of "be" and the modals. */
const NEVER_NOUN: ReadonlySet<string> = new Set([
  "be",
  "am",
  "is",
  "are",
  "was",
  "were",
  "been",
  "can",
  "must",
  "will",
  "cannot",
])

/** Subjects after which an n-only word in its -s form is a verb ("It tests"). */
const SINGULAR_SUBJECTS: ReadonlySet<string> = new Set(["it", "he", "she", "this"])

/** A meaning trap: an approved spelling that is wrong in this sense. */
interface Trap {
  pattern: RegExp
  use: string
}

/** Meaning traps (rule 1.3). Each pattern is narrow on purpose. */
const TRAPS: readonly Trap[] = [
  // FIRE is approved for a weapon or a flame, not for a scheduled start.
  { pattern: /\b(?:fires?|fired)\b/gi, use: 'for a scheduled task, write "starts" or "runs"' },
  // CLEAR (adj) means "easy to see or understand", not "without encryption".
  { pattern: /\bclear\s+(?:JSON|text)\b/gi, use: 'write "plain" or name the format' },
  { pattern: /\bhot\b/gi, use: "name the color, for example pink" },
  { pattern: /\bcarefully\b/gi, use: 'say the condition, for example "only when ..."' },
]

/** The parts of speech that general.json and technical-verbs.json approve, per lemma. */
export interface PosIndex {
  /** Lemma to its approved parts of speech (`v`, `n`, `adj`, ...). */
  pos: ReadonlyMap<string, ReadonlySet<string>>
  /** Technical nouns (rule 1.5): exempt from the noun-use check. */
  technicalNouns: ReadonlySet<string>
}

/** Read the approved parts of speech from the committed dictionary data. */
export function loadPosIndex(dir: string = DICTIONARY_DIR): PosIndex {
  const pos = new Map<string, Set<string>>()
  const add = (word: string, p: string): void => {
    const set = pos.get(word) ?? new Set<string>()
    set.add(p)
    pos.set(word, set)
  }
  const read = <T>(name: string): T[] => JSON.parse(readFileSync(join(dir, name), "utf8")) as T[]
  for (const e of read<{ word: string; pos: string }>("general.json"))
    add(e.word.toLowerCase(), e.pos)
  for (const e of read<{ word: string }>("technical-verbs.json")) add(e.word.toLowerCase(), "v")
  const technicalNouns = new Set<string>()
  for (const e of read<{ word: string }>("technical-nouns.json"))
    technicalNouns.add(e.word.toLowerCase())
  for (const name of readdirSafe(dir)) {
    if (!/^tn-[a-z0-9-]+\.json$/.test(name)) continue
    for (const e of read<{ word: string }>(name)) technicalNouns.add(e.word.toLowerCase())
  }
  return { pos, technicalNouns }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The approved parts of speech of a word form, over every lemma candidate. */
function posOf(form: string, index: PosIndex): ReadonlySet<string> {
  const out = new Set<string>()
  for (const { lemma, inflection } of lemmaCandidates(form.toLowerCase())) {
    // An -er/-est form is an agent noun or a comparison ("reader", "runner",
    // "helper"), not the verb: its POS is not the POS of the stem.
    if (inflection === "er" || inflection === "est") continue
    for (const p of index.pos.get(lemma) ?? []) out.add(p)
  }
  return out
}

/** Readable names of the parts of speech, for messages. */
const POS_NAMES: Readonly<Record<string, string>> = {
  n: "noun",
  v: "verb",
  adj: "adjective",
  adv: "adverb",
}

/** True when a form is a technical noun (base or plural). */
function isTechnicalNoun(form: string, index: PosIndex): boolean {
  return lemmaCandidates(form.toLowerCase()).some(({ lemma }) => index.technicalNouns.has(lemma))
}

/** The 1-based line of an offset. */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length
}

/**
 * s23 findings for one surface text. Error in every role: a verb used as a
 * noun, or a noun used as a verb, is never correct STE.
 *
 * @param args - The masked and raw text, line offset, file and role.
 * @param index - The part-of-speech index.
 * @returns The findings, in text order.
 */
export function posFindings(args: ExtraFindingsArgs, index: PosIndex): SteFinding[] {
  const { masked, lineOffset, role } = args
  const out: SteFinding[] = []
  // A digit token is a number word ("2 reads"). A path or code span with a
  // digit is masked before this rule runs.
  const words = [...masked.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+/g)]
  const lower = (k: number): string => words[k]?.[0].toLowerCase() ?? ""
  // Only a space between two words: punctuation breaks the window.
  const joined = (k: number): boolean => {
    const a = words[k - 1]
    const b = words[k]
    if (!a || !b) return false
    return /^[ \t]+$/.test(masked.slice((a.index ?? 0) + a[0].length, b.index ?? 0))
  }
  const posAt = (k: number): ReadonlySet<string> => {
    const w = words[k]
    return w ? posOf(w[0], index) : new Set<string>()
  }
  const only = (set: ReadonlySet<string>, ...allowed: string[]): boolean =>
    set.size > 0 && [...set].every((p) => allowed.includes(p))
  // An adjective in a noun phrase: approved only as an adjective, or as an
  // adjective and a verb ("correct"): after a determiner it is not a verb.
  const isAdjective = (k: number): boolean => {
    const p = posAt(k)
    return p.has("adj") && only(p, "adj", "v")
  }
  const isAdverb = (k: number): boolean => lower(k) !== "not" && only(posAt(k), "adv")
  // A word that opens a noun phrase: a determiner, a number or a possessive.
  const opensNoun = (k: number): boolean => {
    const w = lower(k)
    if (DETERMINERS.has(w)) return true
    if (MORE_DETERMINERS.has(w)) return true
    // A number opens a noun phrase only when it does not follow a noun: "the
    // value 20 gives the page" has a noun subject, "Give 2 reads" does not.
    if (NUMBER_WORDS.has(w) || /^\d+$/.test(w)) {
      if (!joined(k)) return true
      const prior = words[k - 1]?.[0] ?? ""
      return !posAt(k - 1).has("n") && !isTechnicalNoun(prior, index)
    }
    return w.endsWith("'s") && !NOT_POSSESSIVE.has(w.slice(0, -2))
  }
  // A subject pronoun is a subject only when the word before it is not a
  // verb or a preposition ("Give it", "gives you", "for you").
  const isSubject = (k: number, set: ReadonlySet<string>): boolean => {
    if (!set.has(lower(k))) return false
    if (!joined(k)) return true
    const p = posAt(k - 1)
    if (p.has("v")) return false
    return !(p.has("prep") && !p.has("conj"))
  }
  // A sentence start: the first word, or a word after . ! ? : or a newline.
  const sentenceStart = (k: number): boolean => {
    const w = words[k]
    if (!w) return false
    const prior = words[k - 1]
    const from = prior ? (prior.index ?? 0) + prior[0].length : 0
    const gap = masked.slice(from, w.index ?? 0)
    return k === 0 || /[.!?:\n]/.test(gap)
  }

  /**
   * The verb opener before word i, if any. `strong` openers (a modal, a
   * modal + "not", a subject) also make a technical noun a finding; "to" does
   * not ("Write it to disk").
   */
  const verbOpener = (i: number): { at: number; strong: boolean } | undefined => {
    if (!joined(i)) return undefined
    const before = lower(i - 1)
    if (before === "to") return { at: i - 1, strong: false }
    if (VERB_OPENERS.has(before)) return { at: i - 1, strong: true }
    if (before === "not" && joined(i - 1) && MODALS.has(lower(i - 2)))
      return { at: i - 1, strong: true }
    if (isSubject(i - 1, SUBJECTS)) return { at: i - 1, strong: true }
    // One adverb between the opener and the word ("can quickly test", "You
    // then test"), or an adverb that starts an order ("Then test the file.").
    if (isAdverb(i - 1)) {
      const b2 = lower(i - 2)
      if (joined(i - 1) && (VERB_OPENERS.has(b2) || b2 === "not") && b2 !== "to") {
        if (b2 !== "not" || (joined(i - 2) && MODALS.has(lower(i - 3))))
          return { at: i - 2, strong: true }
      }
      if (joined(i - 1) && isSubject(i - 2, SUBJECTS)) return { at: i - 2, strong: true }
      // Weak: "Then peers can ..." has a technical noun as the subject.
      if (sentenceStart(i - 1)) return { at: i - 1, strong: false }
    }
    return undefined
  }

  const push = (from: number, i: number, message: string): void => {
    const start = words[from]
    const cur = words[i]
    if (!start || !cur) return
    out.push({
      rule: POS_RULE,
      message,
      snippet: masked
        .slice(start.index ?? 0, (cur.index ?? 0) + cur[0].length)
        .replace(/\s+/g, " "),
      line: lineAt(masked, cur.index ?? 0) + lineOffset,
      severity: "error",
      offset: cur.index ?? 0,
      role,
    })
  }

  for (let i = 1; i < words.length; i++) {
    const cur = words[i]
    if (!cur) continue
    const word = cur[0]
    if (/^\d+$/.test(word)) continue
    const pos = posOf(word, index)
    const technical = isTechnicalNoun(word, index)
    // STE 3.3: a past participle can be an adjective ("a stopped job", "the
    // recorded count"), so the noun-use check judges only the base form and
    // the -s form. A -ed or -en form, or an irregular participle, is skipped.
    const nounShape = !/(?:ed|en)$/i.test(word) && !PARTICIPLES.has(word.toLowerCase())

    // NOUN USE: a verb-only word after a determiner, a number or a possessive,
    // with zero or more adjectives between ("the full read", "two reads").
    if (
      nounShape &&
      pos.size === 1 &&
      pos.has("v") &&
      !technical &&
      !NEVER_NOUN.has(word.toLowerCase())
    ) {
      let head = i - 1
      while (head > 0 && joined(head + 1) && !opensNoun(head) && isAdjective(head)) head--
      if (joined(head + 1) && opensNoun(head)) {
        push(
          head,
          i,
          `"${word}" is approved only as a verb (STE 1.2): do not use it as a noun after "${words[head]?.[0]}"`,
        )
        continue
      }
    }

    // VERB USE: a noun-only or adjective-only word (or a technical noun that
    // is not also an approved verb) in a verb position.
    const nounOrAdj = only(pos, "n", "adj")
    const opener = verbOpener(i)
    if (opener && (nounOrAdj || (opener.strong && technical && !pos.has("v")))) {
      const what =
        pos.size > 0
          ? `approved only as a ${[...pos].map((p) => POS_NAMES[p] ?? p).join(" or ")} (STE 1.2)`
          : "a technical noun, never a verb (STE 1.5)"
      push(
        opener.at,
        i,
        `"${word}" is ${what}: do not use it as a verb after "${words[opener.at]?.[0]}"`,
      )
      continue
    }

    // M7b: a noun-only lemma in its -s form after "it", "he", "she" or "this"
    // ("It tests the file."). "The tool files" stays quiet: a compound noun.
    if (
      joined(i) &&
      isSubject(i - 1, SINGULAR_SUBJECTS) &&
      !pos.has("v") &&
      lemmaCandidates(word.toLowerCase()).some(
        ({ lemma, inflection }) =>
          inflection === "s" && only(index.pos.get(lemma) ?? new Set<string>(), "n"),
      )
    ) {
      push(
        i - 1,
        i,
        `"${word}" is the -s form of a word that is approved only as a noun (STE 1.2): do not use it as a verb after "${words[i - 1]?.[0]}"`,
      )
    }
  }
  for (const trap of TRAPS) {
    trap.pattern.lastIndex = 0
    for (const m of masked.matchAll(trap.pattern)) {
      out.push({
        rule: POS_RULE,
        message: `"${m[0]}" has a meaning that STE does not approve here (STE 1.3): ${trap.use}`,
        snippet: m[0],
        line: lineAt(masked, m.index ?? 0) + lineOffset,
        severity: "error",
        offset: m.index ?? 0,
        role,
      })
    }
  }
  return out.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))
}
