/**
 * Tests for the `ste-s19-dictionary` word lists (ASD-STE100 rule 1.1).
 *
 * 1. Behavior: the lemmatizer table, `check` verdicts and `dictionaryFindings`.
 * 2. Integrity (always): sorted, unique, no word both general and unapproved,
 *    every `use` made of general or TV words, reasons of 20 or more
 *    characters, and the stale guards (every TN, TV, compound and unapproved
 *    entry and every pending (word, file) pair still occurs in the corpus).
 * 3. Reference verifier: runs only when the local reference dictionary exists
 *    (`~/.minimal-agent/ste/ste100-issue9.json` or env `STE_REFERENCE`). That
 *    file is never committed. Without it, the test prints a notice and skips.
 *
 * @module tests/ste/ste-dictionary.test
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  computePending,
  corpusLemmas,
  corpusMisses,
  corpusTokens,
  loadReference,
  pendingAdditions,
  pendingCounts,
  pendingKeys,
  pendingText,
  referencePath,
  staleEntries,
  staleLabels,
  stalePending,
  verifyAgainstReference,
} from "../../scripts/ste-dict.ts"

import {
  buildDictionary,
  type DictionaryData,
  defaultAutoTechNouns,
  dictionaryFindings,
  lemmaCandidates,
  loadDictionary,
  type Pos,
  readDictionaryData,
} from "./dictionary.ts"
import { lockKey, readLock } from "./ratchet.ts"
import { maskNonProse } from "./ste-rules.ts"

const data = readDictionaryData()
const dict = loadDictionary()
const tokens = corpusTokens()
const lemmas = corpusLemmas(tokens, data)

/** A small dictionary for behavior tests: no corpus, no auto names. */
function tiny(extra: Partial<DictionaryData> = {}): ReturnType<typeof buildDictionary> {
  const base: DictionaryData = {
    general: [
      { word: "file", pos: "n" },
      { word: "give", pos: "v" },
      { word: "only", pos: "adj" },
      { word: "read", pos: "v" },
      { word: "set", pos: "v" },
      { word: "stop", pos: "v" },
      { word: "the", pos: "art" },
      { word: "use", pos: "v" },
    ],
    unapproved: [{ word: "utilize", pos: "v", use: "use" }],
    technicalNouns: [{ word: "JSON", category: 19, reason: "a text data format for values" }],
    technicalVerbs: [{ word: "run", category: "2c", reason: "run a command, a script or a test" }],
    compounds: [{ word: "sub-agent", reason: "a child agent that the lead agent starts" }],
    irregular: data.irregular,
    pending: [],
    ...extra,
  }
  return buildDictionary(base, ["ScheduleCronList", "clear-stale"])
}

describe("lemmaCandidates", () => {
  const table: Array<[string, string]> = [
    ["setting", "set"],
    ["using", "use"],
    ["used", "use"],
    ["stopped", "stop"],
    ["gave", "give"],
    ["data", "data"],
    ["ids", "id"],
    ["queries", "query"],
    ["boxes", "box"],
    ["matches", "match"],
    ["goes", "go"],
    ["copied", "copy"],
    ["making", "make"],
    ["running", "run"],
    ["dying", "die"],
    ["larger", "large"],
    ["easiest", "easy"],
    ["fully", "full"],
    ["basically", "basical"],
    ["status", "status"],
    ["process", "process"],
    ["children", "child"],
    ["file's", "file"],
    ["files'", "file"],
    ["sub-agents", "sub-agent"],
  ]
  for (const [form, lemma] of table) {
    test(`${form} -> ${lemma}`, () => {
      expect(lemmaCandidates(form).map((c) => c.lemma)).toContain(lemma)
    })
  }
  test("no -s strip after us, ss or is", () => {
    expect(lemmaCandidates("status").map((c) => c.lemma)).not.toContain("statu")
    expect(lemmaCandidates("process").map((c) => c.lemma)).not.toContain("proces")
    expect(lemmaCandidates("analysis").map((c) => c.lemma)).not.toContain("analysi")
  })
})

describe("check", () => {
  const d = tiny()
  test("accepts approved forms", () => {
    for (const word of ["file", "files", "file's", "gave", "given", "uses", "used", "stopped"]) {
      expect(d.check(word)).toMatchObject({ ok: true, via: "general" })
    }
  })
  test("accepts TN, TV, compound, auto and identifiers", () => {
    expect(d.check("JSON")).toMatchObject({ ok: true, via: "tn" })
    expect(d.check("runs")).toMatchObject({ ok: true, via: "tv" })
    expect(d.check("ran")).toMatchObject({ ok: true, via: "tv" })
    expect(d.check("sub-agents")).toMatchObject({ ok: true, via: "compound" })
    expect(d.check("read-only")).toMatchObject({ ok: true })
    expect(d.check("ScheduleCronList")).toMatchObject({ ok: true, via: "auto" })
    expect(d.check("clear-stale")).toMatchObject({ ok: true, via: "auto" })
    expect(d.check("file_path")).toMatchObject({ ok: true, via: "auto" })
  })
  test("rejects unapproved forms with the fix", () => {
    expect(d.check("utilize")).toEqual({ ok: false, reason: "unapproved", use: "use" })
    expect(d.check("utilized")).toEqual({ ok: false, reason: "unapproved", use: "use" })
    expect(d.check("utilizing")).toEqual({ ok: false, reason: "unapproved", use: "use" })
  })
  test("rejects the -ing form of an approved verb or a TV (rule 3.5)", () => {
    expect(d.check("using")).toMatchObject({ ok: false, reason: "unapproved" })
    expect(d.check("running")).toMatchObject({ ok: false, reason: "unapproved" })
    expect(d.check("setting")).toMatchObject({ ok: false, reason: "unapproved" })
  })
  test("rejects unknown words, CamelCase and wrong parts of speech", () => {
    expect(d.check("frobnicate")).toEqual({ ok: false, reason: "unknown" })
    expect(d.check("Chromium")).toEqual({ ok: false, reason: "unknown" })
    expect(d.check("DevTools")).toEqual({ ok: false, reason: "unknown" })
    // A verb takes no -est, an adjective takes no -ly unless it is an entry.
    expect(d.check("givest")).toEqual({ ok: false, reason: "unknown" })
    expect(d.check("onlyly")).toEqual({ ok: false, reason: "unknown" })
    // A noun takes no -ed.
    expect(d.check("filed")).toEqual({ ok: false, reason: "unknown" })
  })
  test("a plain lowercase auto name is judged as a word", () => {
    const withAuto = buildDictionary(readDictionaryData(), ["fleet", "Fleet"])
    expect(withAuto.check("fleet").ok).toBe(false)
  })
  test("isVerb: general verbs and TVs, base form", () => {
    expect(d.isVerb("give")).toBe(true)
    expect(d.isVerb("run")).toBe(true)
    expect(d.isVerb("file")).toBe(false)
  })
  test("the committed lists: return and call are not TVs, run is", () => {
    expect(dict.check("return").ok).toBe(false)
    expect(dict.check("returns").ok).toBe(false)
    expect(dict.check("call").ok).toBe(false)
    expect(dict.check("run")).toMatchObject({ ok: true, via: "tv" })
  })
})

describe("dictionaryFindings", () => {
  const find = (text: string, file: string, role: "tool" | "param" | "prose", d = tiny()) =>
    dictionaryFindings(maskNonProse(text), text, 0, file, role, d)

  test("Utilize the frobnicator: 2 findings", () => {
    const found = find("Utilize the frobnicator.", "x.md", "prose")
    expect(found.map((f) => f.snippet)).toEqual(["Utilize", "frobnicator"])
    expect(found[0]?.message).toContain('use "use"')
    expect(found.every((f) => f.rule === "ste-s19-dictionary" && f.severity === "error")).toBe(true)
  })
  test("pending covers a word only in its own file and only in the prose role", () => {
    const d = tiny({ pending: [{ word: "frobnicator", files: ["x.md"] }] })
    expect(find("Utilize the frobnicator.", "x.md", "prose", d)).toHaveLength(1)
    expect(find("Utilize the frobnicator.", "y.md", "prose", d)).toHaveLength(2)
    expect(find("Utilize the frobnicator.", "x.md", "tool", d)).toHaveLength(2)
    expect(find("Utilize the frobnicator.", "x.md", "param", d)).toHaveLength(2)
  })
  test("masked code is not judged, line numbers and role are set", () => {
    const found = find("Use the `frobnicate` file.\nThe frobnicator.", "x.md", "tool")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ line: 2, role: "tool", snippet: "frobnicator" })
  })
})

/** Strictly increasing in code-unit order, by word and then by part of speech. */
function sorted(keys: ReadonlyArray<string | readonly [string, string]>): boolean {
  const pair = (k: string | readonly [string, string]): readonly [string, string] =>
    typeof k === "string" ? [k, ""] : k
  return keys.every((k, i) => {
    if (i === 0) return true
    const [a, b] = [pair(keys[i - 1] as string), pair(k)]
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  })
}

/** The words of a `use` text: an approved multi-word entry, or single words. */
function useWords(use: string): string[][] {
  return use.split(",").map((part) => part.trim().split(/\s+/))
}

describe("integrity", () => {
  test("the corpus is found", () => {
    expect(tokens.length).toBeGreaterThan(5000)
  })
  test("every list is sorted and unique", () => {
    expect(sorted(data.general.map((e) => [e.word, e.pos] as const))).toBe(true)
    expect(sorted(data.unapproved.map((e) => [e.word, e.pos] as const))).toBe(true)
    expect(sorted(data.technicalVerbs.map((e) => e.word))).toBe(true)
    expect(sorted(data.compounds.map((e) => e.word))).toBe(true)
    expect(sorted(data.pending.map((e) => e.word))).toBe(true)
    // TN: technical-nouns.json plus every tn-<area>.json, unique over all.
    const tn = data.technicalNouns.map((e) => e.word.toLowerCase())
    expect(new Set(tn).size).toBe(tn.length)
    for (const entry of data.pending) expect(sorted(entry.files)).toBe(true)
    expect(sorted(Object.keys(data.irregular))).toBe(true)
  })
  test("no word is both general and unapproved", () => {
    const general = new Set(data.general.map((e) => e.word))
    expect(data.unapproved.filter((e) => general.has(e.word)).map((e) => e.word)).toEqual([])
  })
  test("no TV is also unapproved", () => {
    // A TV accepts every verb form, so an unapproved entry for it is dead.
    // A TN may have an unapproved VERB entry (`request` n is a TN, `requested`
    // gives "tell, write"), and a word may be a TN and a TV when both meanings
    // occur (`format` the noun and the verb). Rules 1.7 and 1.13 are left to
    // review: the token check cannot see the part of speech.
    const unapproved = new Set(data.unapproved.map((e) => e.word))
    expect(data.technicalVerbs.filter((e) => unapproved.has(e.word)).map((e) => e.word)).toEqual([])
    const unapprovedNoun = new Set(data.unapproved.filter((e) => e.pos === "n").map((e) => e.word))
    expect(
      data.technicalNouns.filter((e) => unapprovedNoun.has(e.word)).map((e) => e.word),
    ).toEqual([])
  })
  test("every use is made of general words or TVs", () => {
    const allowed = new Set([
      ...data.general.map((e) => e.word),
      ...data.technicalVerbs.map((e) => e.word),
    ])
    const bad: string[] = []
    for (const entry of data.unapproved) {
      for (const [index, words] of useWords(entry.use).entries()) {
        const phrase = words.join(" ")
        if (phrase.length === 0) bad.push(`${entry.word}: empty use part ${index}`)
        else if (!allowed.has(phrase) && !words.every((w) => allowed.has(w))) {
          bad.push(`${entry.word}: "${phrase}"`)
        }
      }
    }
    expect(bad).toEqual([])
  })
  test("parts of speech and categories are valid", () => {
    const pos = new Set<Pos>(["n", "v", "adj", "adv", "pron", "art", "prep", "conj", "num"])
    expect(data.general.filter((e) => !pos.has(e.pos))).toEqual([])
    expect(data.unapproved.filter((e) => !pos.has(e.pos))).toEqual([])
    const tnBad = data.technicalNouns.filter(
      (e) =>
        !Number.isInteger(e.category) || (e.category as number) < 1 || (e.category as number) > 22,
    )
    expect(tnBad).toEqual([])
    const tvBad = data.technicalVerbs.filter(
      (e) => !["2a", "2b", "2c"].includes(String(e.category)),
    )
    expect(tvBad).toEqual([])
  })
  test("every TN, TV and compound reason has 20 or more characters", () => {
    const short = [...data.technicalNouns, ...data.technicalVerbs, ...data.compounds]
      .filter((e) => e.reason.trim().length < 20)
      .map((e) => e.word)
    expect(short).toEqual([])
  })
  test("irregular forms map to a lemma, not to themselves only by accident", () => {
    for (const [form, lemma] of Object.entries(data.irregular)) {
      expect(form).toBe(form.toLowerCase())
      expect(lemma.length).toBeGreaterThan(0)
    }
  })
})

/** A short hash of a sorted, lowercased word list. */
function fingerprint(words: readonly string[]): string {
  const text = [...words]
    .map((w) => w.toLowerCase())
    .sort()
    .join("\n")
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

describe("allow lists are pinned (REVIEW-C2 D3)", () => {
  // A technical noun, a technical verb or a compound ALLOWS a word, so a new
  // entry opens a hole that later text can use without review. general.json is
  // checked against the reference; these lists are not, so each change must
  // change this test too. To add an entry: add it with a reason (DESIGN.md
  // section 9: only when no approved word or code span can carry the meaning),
  // then update the count and the hash here in the same commit.
  const data = readDictionaryData()
  test("technical nouns", () => {
    const words = data.technicalNouns.map((e) => e.word)
    expect([words.length, fingerprint(words)]).toEqual([267, "42ba3bda7ad8310e"])
  })
  test("technical verbs", () => {
    const words = data.technicalVerbs.map((e) => e.word)
    expect([words.length, fingerprint(words)]).toEqual([24, "7824b9f909dfcd6b"])
  })
  test("compounds", () => {
    const words = data.compounds.map((e) => e.word)
    expect([words.length, fingerprint(words)]).toEqual([8, "ae4acf32ac699a97"])
  })
  test("a swap of one entry changes the hash", () => {
    const words = data.technicalNouns.map((e) => e.word)
    const swapped = [...words.slice(1), "gizmo"]
    expect(swapped.length).toBe(words.length)
    expect(fingerprint(swapped)).not.toBe(fingerprint(words))
  })
})

describe("stale guard", () => {
  test("every TN, TV and compound entry occurs in the corpus", () => {
    expect(staleEntries(data, lemmas)).toEqual([])
  })
  test("every label is named in a code span of some surface", () => {
    expect(staleLabels(data)).toEqual([])
    const fake: DictionaryData = {
      ...data,
      labels: [{ word: "zzlabel", source: "x", reason: "a test label" }],
    }
    expect(staleLabels(fake)).toEqual(["label: zzlabel"])
  })
  test("the guard reports an entry that does not occur", () => {
    const fake: DictionaryData = {
      ...data,
      technicalNouns: [...data.technicalNouns, { word: "zzframe", category: 19, reason: "x" }],
      compounds: [...data.compounds, { word: "zz-frame", reason: "x" }],
    }
    expect(staleEntries(fake, lemmas)).toEqual(["technical noun: zzframe", "compound: zz-frame"])
  })
  const live = computePending(
    corpusMisses(tokens, buildDictionary({ ...data, pending: [] }, defaultAutoTechNouns())),
  )
  test("every pending (word, file) still fails in that file", () => {
    expect(stalePending(data.pending, live)).toEqual([])
  })
  test("the pending guard reports a fixed pair", () => {
    const fake = [{ word: "zzframe", files: ["x.md"] }, ...data.pending]
    expect(stalePending(fake, live)).toEqual(["zzframe @ x.md"])
  })
  test("pending lists prose-role files only (tool and param roles have no pending)", () => {
    const proseFiles = new Set(tokens.filter((t) => t.role === "prose").map((t) => t.file))
    const notProse = data.pending.flatMap((e) => e.files.filter((f) => !proseFiles.has(f)))
    expect(notProse).toEqual([])
    expect(live.flatMap((e) => e.files.filter((f) => !proseFiles.has(f)))).toEqual([])
  })
  test("no pending word passes the dictionary", () => {
    expect(data.pending.filter((e) => dict.check(e.word).ok).map((e) => e.word)).toEqual([])
  })
})

describe("pending ratchet (REVIEW-C B1)", () => {
  const lock = readLock()
  const misses = corpusMisses(
    tokens,
    buildDictionary({ ...data, pending: [] }, defaultAutoTechNouns()),
  )
  const counts = pendingCounts(misses)

  test("no (word, file) pair of the tree is above the lock: no new pair, no higher count", () => {
    expect(pendingAdditions(counts, lock.pending)).toEqual([])
  })

  test("pending.json has no pair that the lock does not allow", () => {
    const allowed = new Set(Object.keys(lock.pending))
    expect(pendingKeys(data.pending).filter((key) => !allowed.has(key))).toEqual([])
  })

  test("pending.json lists exactly the pairs of the tree", () => {
    expect(pendingKeys(data.pending).sort()).toEqual(Object.keys(counts).sort())
  })

  test("pendingAdditions reports a new pair and a higher count", () => {
    const ceiling = { [lockKey("frob", "a.md")]: 2 }
    expect(pendingAdditions({ [lockKey("frob", "a.md")]: 2 }, ceiling)).toEqual([])
    expect(pendingAdditions({ [lockKey("frob", "a.md")]: 1 }, ceiling)).toEqual([])
    expect(
      pendingAdditions(
        {
          [lockKey("frob", "a.md")]: 3,
          [lockKey("frob", "b.md")]: 1,
          [lockKey("zork", "a.md")]: 1,
        },
        ceiling,
      ),
    ).toEqual(["frob @ a.md: 3 > 2", "frob @ b.md: 1 > 0 (new)", "zork @ a.md: 1 > 0 (new)"])
  })

  test("a planted unknown word in a real prose file is above the lock", () => {
    // The REVIEW-C attack: "frobnicator awesome stuff" in a PROMPT.md, then
    // --write-pending. The new pairs are above the lock, so the write refuses.
    const file = "ma-agent-writing-style-plugin/PROMPT.md"
    const planted = corpusMisses(
      [
        { word: "frobnicator", form: "frobnicator", file, locator: "x", line: 1, role: "prose" },
        { word: "awesome", form: "awesome", file, locator: "x", line: 1, role: "prose" },
      ],
      dict,
    )
    const next = { ...lock.pending, ...pendingCounts(planted) }
    expect(pendingAdditions(next, lock.pending)).toEqual([
      `awesome @ ${file}: 1 > 0 (new)`,
      `frobnicator @ ${file}: 1 > 0 (new)`,
    ])
  })

  test("one more use of a pending word in its own file is above the lock", () => {
    // REVIEW-C B1: pending had no count, so "accent" could be used any number
    // of extra times in ma-speak-plugin/PROMPT.md.
    const [key, count] = Object.entries(lock.pending)[0] ?? ["", 0]
    expect(count).toBeGreaterThan(0)
    const next = { ...lock.pending, [key]: count + 1 }
    expect(pendingAdditions(next, lock.pending)).toEqual([`${key}: ${count + 1} > ${count}`])
  })

  test("pendingCounts counts each prose occurrence, not tool or param ones", () => {
    const one = (role: "tool" | "param" | "prose", file = "a.md") => ({
      token: { word: "frob", form: "frob", file, locator: "x", line: 1, role },
      reason: "unknown" as const,
    })
    expect(
      pendingCounts([one("prose"), one("prose"), one("tool"), one("param"), one("prose", "b.md")]),
    ).toEqual({
      [lockKey("frob", "a.md")]: 2,
      [lockKey("frob", "b.md")]: 1,
    })
  })
})

describe("reference verifier", () => {
  const ref = loadReference()
  if (!ref) {
    console.log(
      `ste-dictionary: no local reference at ${referencePath()}, the verifier is skipped (set STE_REFERENCE)`,
    )
    test.skip("lists agree with the reference", () => {})
    return
  }
  test("lists agree with the reference", () => {
    expect(verifyAgainstReference(data, ref)).toEqual([])
  })
  test("the verifier catches a bad entry", () => {
    const broken: DictionaryData = {
      ...data,
      general: [...data.general, { word: "utilize", pos: "v" }],
      unapproved: [...data.unapproved, { word: "give", pos: "v", use: "give" }],
      technicalVerbs: [
        ...data.technicalVerbs,
        { word: "give", category: "2c", reason: "x".repeat(20) },
      ],
    }
    expect(verifyAgainstReference(broken, ref)).toHaveLength(3)
  })
})

describe("pendingText (the writer output passes biome)", () => {
  test("a short files list stays on one line, a long one breaks", () => {
    const long = Array.from({ length: 6 }, (_, i) => `ma-a-very-long-plugin-name-${i}/PROMPT.md`)
    expect(
      pendingText([
        { word: "absent", files: ["ma-x/PROMPT.md"] },
        { word: "big", files: long },
      ]),
    ).toBe(
      [
        "[",
        "  {",
        '    "word": "absent",',
        '    "files": ["ma-x/PROMPT.md"]',
        "  },",
        "  {",
        '    "word": "big",',
        '    "files": [',
        ...long.map((f, i) => `      "${f}"${i < long.length - 1 ? "," : ""}`),
        "    ]",
        "  }",
        "]",
        "",
      ].join("\n"),
    )
  })
  test("the committed pending.json is the writer output", () => {
    const text = readFileSync(join(import.meta.dir, "dictionary", "pending.json"), "utf8")
    expect(pendingText(data.pending)).toBe(text)
  })
})
