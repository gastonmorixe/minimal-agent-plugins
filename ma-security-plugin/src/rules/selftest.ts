// Self-test runner (SPEC-v3 "Self-test runner", J section 4). Sync, pure, never throws.
// The registry runs it at load. CI runs it from tests.
import { buildAutomaton } from "../engine/prefilter.ts"
import { shannon, VALIDATORS } from "../engine/validators.ts"
import { LEVELS_ON, markerSamples, renderMarker } from "../redact/markers.ts"

import { ALLOWLISTS } from "./allowlists.ts"
import { fillExample } from "./gen.ts"
import type { AnyRule, CmdDecision, CmdRule, Example, PathRule, RedactRule } from "./types.ts"

export type SelfTestResult = { id: string; ok: true } | { id: string; ok: false; reason: string }

/** A redact rule with its compiled regex and allowlists. */
export type CompiledRedactRule = {
  readonly rule: RedactRule
  /** Null for known-value only rules (no pattern). Flags include "g", plus "d" for a capture group. */
  readonly re: RegExp | null
  /** Tested against the whole capture. */
  readonly allowPatterns: readonly RegExp[]
  /** Lowercase. The whole capture must equal one. */
  readonly allowWords: readonly string[]
  /** Lowercase. A capture that contains one is allowed (stopwords opt-in only). */
  readonly allowSubstrings: readonly string[]
}

/** One raw rule hit (no kind or layer yet). */
export type RuleHit = { start: number; end: number; value: string }

export type ScanRuleOptions = {
  /** Skip min_len, validator, entropy, and allowlists. */
  raw?: boolean
  /** Stop after this many hits. Default 10000. */
  limit?: number
}

/** Max distance in chars between a keyword hit and the span (windowed mode over 4 MB). */
export const KEYWORD_WINDOW = 300

/** Compile a redact rule. Returns the compiled form or an error string. Never throws. */
export function compileRedactRule(rule: RedactRule): CompiledRedactRule | string {
  try {
    const flags = rule.flags ?? ""
    if (flags !== "" && flags !== "i") return `bad flags "${String(flags)}"`
    if (rule.validator !== undefined && !Object.hasOwn(VALIDATORS, rule.validator))
      return `unknown validator "${rule.validator}"`
    // fix3 MINOR 5, fix4 MINOR 1: here so skipSelfTest cannot bypass it. Substring
    // stopwords are for the generic kv rule, never a provider rule.
    if (rule.allowStopwords === true && rule.render?.publicPrefix !== undefined)
      return "allowStopwords is not allowed on a provider rule (publicPrefix set)"
    const group = rule.group ?? 0
    let re: RegExp | null = null
    if (rule.pattern !== undefined)
      re = new RegExp(rule.pattern, `${flags}g${group > 0 ? "d" : ""}`)
    const allowPatterns: RegExp[] = []
    const allowWords: string[] = []
    const allowSubstrings: string[] = []
    for (const id of rule.allow ?? []) {
      const list = ALLOWLISTS[id]
      if (!list) return `unknown allowlist "${id}"`
      if (list.substring && rule.allowStopwords !== true)
        return `allowlist "${id}" needs allowStopwords: true`
      for (const p of list.patterns) allowPatterns.push(new RegExp(p, "i"))
      for (const w of list.words) (list.substring ? allowSubstrings : allowWords).push(w)
    }
    return { rule, re, allowPatterns, allowWords, allowSubstrings }
  } catch (e) {
    return `compile: ${e instanceof Error ? e.message : String(e)}`
  }
}

function passesFilters(c: CompiledRedactRule, value: string): boolean {
  const r = c.rule
  if (r.defaults.min_len !== undefined && value.length < r.defaults.min_len) return false
  if (r.validator !== undefined && !VALIDATORS[r.validator](value)) return false
  if (r.entropy !== undefined && shannon(value) < r.entropy.min) return false
  if (c.allowPatterns.some((p) => p.test(value))) return false
  const lower = value.toLowerCase()
  if (c.allowWords.includes(lower)) return false
  if (c.allowSubstrings.some((w) => lower.includes(w))) return false
  return true
}

/** Run one compiled rule over text (exec loop). No prefilter, no merge. */
export function scanRule(
  c: CompiledRedactRule,
  text: string,
  opts: ScanRuleOptions = {},
): RuleHit[] {
  const hits: RuleHit[] = []
  const re = c.re
  if (re === null) return hits
  const group = c.rule.group ?? 0
  const limit = opts.limit ?? 10000
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex++
    const value = m[group]
    if (value === undefined || value.length === 0) continue
    let start = m.index
    if (group > 0) {
      const span = m.indices?.[group]
      if (span === undefined) continue
      start = span[0]
    }
    if (!opts.raw && !passesFilters(c, value)) continue
    hits.push({ start, end: start + value.length, value })
    if (hits.length >= limit) break
  }
  re.lastIndex = 0
  return hits
}

// Static shape check: a small tokenizer that skips escapes and char classes.

type Quant = { min: number; max: number | null; lazy: boolean }
type Node =
  /** One char-width atom. `src` is its regex source (null for a backreference). */
  | { t: "atom"; q: Quant | null; src: string | null }
  | { t: "assert" }
  /** Lookaround: an assertion with a body. Quantifier kept for the walk (Annex B). */
  | { t: "look"; alts: Node[][]; q: Quant | null }
  | { t: "group"; alts: Node[][]; q: Quant | null }

/** Bound above which a quantifier is flagged "huge bound". */
export const HUGE_BOUND = 1024

const QUANT_BRACE = /^\{(\d+)(,(\d*))?\}/

function parseQuant(p: string, i: number): { q: Quant; next: number } | null {
  const c = p[i]
  let q: Quant | null = null
  let next = i + 1
  if (c === "*") q = { min: 0, max: null, lazy: false }
  else if (c === "+") q = { min: 1, max: null, lazy: false }
  else if (c === "?") q = { min: 0, max: 1, lazy: false }
  else if (c === "{") {
    const m = QUANT_BRACE.exec(p.slice(i))
    if (m === null) return null
    const min = Number(m[1])
    const max = m[2] === undefined ? min : m[3] === "" ? null : Number(m[3])
    q = { min, max, lazy: false }
    next = i + m[0].length
  }
  if (q === null) return null
  if (p[next] === "?") {
    q.lazy = true
    next++
  }
  return { q, next }
}

/** Parse alternatives until ")" or end. Returns the index after the closing ")". */
function parseAlts(p: string, start: number): { alts: Node[][]; next: number } {
  const alts: Node[][] = [[]]
  let i = start
  while (i < p.length) {
    const c = p[i] as string
    const seq = alts[alts.length - 1] as Node[]
    if (c === ")") return { alts, next: i + 1 }
    if (c === "|") {
      alts.push([])
      i++
      continue
    }
    let node: Node
    if (c === "\\") {
      const e = p[i + 1] ?? ""
      let len = 2
      if (e === "u" && /^[0-9A-Fa-f]{4}$/.test(p.slice(i + 2, i + 6))) len = 6
      else if (e === "x" && /^[0-9A-Fa-f]{2}$/.test(p.slice(i + 2, i + 4))) len = 4
      else if (e === "c" && /^[A-Za-z]$/.test(p[i + 2] ?? "")) len = 3
      const src = p.slice(i, i + len)
      if (e === "b" || e === "B") node = { t: "assert" }
      else node = { t: "atom", q: null, src: /^[1-9k]$/.test(e) ? null : src }
      i += len
    } else if (c === "[") {
      let j = i + 1
      if (p[j] === "^") j++
      while (j < p.length && p[j] !== "]") j += p[j] === "\\" ? 2 : 1
      node = { t: "atom", q: null, src: p.slice(i, j + 1) }
      i = j + 1
    } else if (c === "(") {
      // Group head: (?: (?= (?! (?<= (?<! (?<name>. Lookarounds are assertions.
      let j = i + 1
      let look = false
      if (p[j] === "?") {
        const n1 = p[j + 1]
        const n2 = p.slice(j + 1, j + 3)
        if (n2 === "<=" || n2 === "<!") {
          look = true
          j += 3
        } else if (n2.startsWith("<")) {
          const close = p.indexOf(">", j)
          j = close === -1 ? p.length : close + 1
        } else {
          look = n1 === "=" || n1 === "!"
          j += 2
        }
      }
      const inner = parseAlts(p, j)
      node = look
        ? { t: "look", alts: inner.alts, q: null }
        : { t: "group", alts: inner.alts, q: null }
      i = inner.next
    } else if (c === "^" || c === "$") {
      node = { t: "assert" }
      i++
    } else {
      node = { t: "atom", q: null, src: c }
      i++
    }
    if (node.t !== "assert") {
      const pq = parseQuant(p, i)
      if (pq !== null) {
        node.q = pq.q
        i = pq.next
      }
    }
    seq.push(node)
  }
  return { alts, next: i }
}

function variable(q: Quant | null): boolean {
  return q !== null && q.min !== q.max
}

/** True when the body holds a variable quantifier or an alternation, at any depth. */
function ambiguousBody(alts: Node[][]): boolean {
  if (alts.length > 1) return true
  for (const seq of alts)
    for (const n of seq) {
      if (n.t === "assert") continue
      if (variable(n.q)) return true
      if ((n.t === "group" || n.t === "look") && ambiguousBody(n.alts)) return true
    }
  return false
}

// Char sets of single-char atoms, exact over every UTF-16 code unit (no u flag, so a
// regex sees code units). Case-insensitive on purpose: a rule may use the "i" flag.
const CHARSET_CACHE = new Map<string, Uint8Array | null>()

function charSet(src: string | null): Uint8Array | null {
  if (src === null) return null
  const hit = CHARSET_CACHE.get(src)
  if (hit !== undefined) return hit
  let set: Uint8Array | null = null
  try {
    const re = new RegExp(`^(?:${src})$`, "i")
    set = new Uint8Array(0x10000)
    for (let c = 0; c < 0x10000; c++) if (re.test(String.fromCharCode(c))) set[c] = 1
  } catch {
    set = null
  }
  CHARSET_CACHE.set(src, set)
  return set
}

function disjoint(a: Uint8Array, b: Uint8Array): boolean {
  for (let c = 0; c < a.length; c++) if (a[c] === 1 && b[c] === 1) return false
  return true
}

/**
 * mn3: a repeated body that cannot split one input two ways. Every alternative is
 * atoms only. Its first atom has no quantifier, and the first-atom sets of all
 * alternatives are pairwise disjoint. After the first atom: fixed-count atoms only, or
 * exactly one bounded variable atom whose set excludes every first-atom set (a fixed
 * separator then one bounded run, like `-[a-z0-9]{4,8}`).
 */
function safeRepeatBody(alts: Node[][]): boolean {
  const firsts: Uint8Array[] = []
  const tails: Node[][] = []
  for (const seq of alts) {
    const first = seq[0]
    if (first === undefined || first.t !== "atom" || first.q !== null) return false
    if (seq.some((n) => n.t !== "atom")) return false
    const set = charSet(first.src)
    if (set === null) return false
    for (const f of firsts) if (!disjoint(f, set)) return false
    firsts.push(set)
    tails.push(seq.slice(1))
  }
  for (const tail of tails) {
    if (!tail.some((n) => n.t === "atom" && variable(n.q))) continue
    const run = tail[0]
    if (tail.length !== 1 || run === undefined || run.t !== "atom") return false
    if (run.q === null || run.q.max === null) return false
    const set = charSet(run.src)
    if (set === null) return false
    for (const f of firsts) if (!disjoint(f, set)) return false
  }
  return true
}

function overlaps(a: Uint8Array, b: Uint8Array): boolean {
  return !disjoint(a, b)
}

/**
 * fix3 MAJOR 1: true when a sequence holds two variable atoms (min != max) with
 * overlapping char sets that can sit next to each other in a match. Between them only
 * assertions, lookarounds, optional atoms (min 0), or atoms whose set overlaps the first
 * one may sit (the first run can absorb those). A disjoint required atom or a group is
 * a hard separator. Budget is zero: one such pair is flagged (`[a-z]{1,40}[a-z0-9]{1,40}`
 * splits a run n ways per start). Write one class instead, or opt out with
 * "reviewed:overlap".
 * fix4 BLOCKER 1a: groups with one alternative and no quantifier (or a count of exactly 1) are flattened
 * into the sequence. Other groups are compared by the atoms they can start and end with.
 * An optional group (min 0, or one that can match empty) is skipped like an optional
 * atom. A required group is skipped only when every atom in it overlaps the first run.
 */
function overlapInSeq(seq: readonly Node[]): boolean {
  const items = flattenSeq(seq)
  for (let i = 0; i < items.length; i++) {
    const a = items[i] as Item
    // Left ends: a variable atom, or the variable last atoms of a group.
    const lefts: Uint8Array[] = []
    if (a.t === "atom") {
      if (!variable(a.q)) continue
      const s = charSet(a.src)
      if (s === null) continue
      lefts.push(s)
    } else if (a.t === "sum") {
      for (const e of a.last) if (e.variable && e.set !== null) lefts.push(e.set)
    }
    for (const setA of lefts) if (overlapAfter(items, i, setA)) return true
  }
  return false
}

/** One edge atom of a group: its char set (null for a backreference) and whether it varies. */
type Edge = { set: Uint8Array | null; variable: boolean }
/**
 * fix4 BLOCKER 1a: a group that is not flattened, seen from outside. `first` and `last`
 * are the atoms a match of the group can start or end with. `optional` is true when the
 * group can match empty (min 0, or an empty alternative). `alts` is kept for the
 * transparency test.
 */
type Item =
  | Extract<Node, { t: "atom" }>
  | { t: "assert" }
  | { t: "sum"; first: Edge[]; last: Edge[]; optional: boolean; alts: Node[][] }

/**
 * Flatten groups with one alternative and no quantifier (or a count of exactly 1) into the sequence.
 * Every other group becomes a summary item. Lookarounds become assertions.
 */
function flattenSeq(seq: readonly Node[], out: Item[] = []): Item[] {
  for (const n of seq) {
    if (n.t === "assert" || n.t === "look") out.push({ t: "assert" })
    else if (n.t === "atom") out.push(n)
    else if (n.alts.length === 1 && (n.q === null || (n.q.min === 1 && n.q.max === 1)))
      flattenSeq(n.alts[0] as Node[], out)
    else {
      // A repeated group does not make its edge atoms vary: a fixed last atom still ends
      // the group at a fixed char. Ambiguous repeated bodies are the nested check's job.
      out.push({
        t: "sum",
        first: edges(n.alts, false),
        last: edges(n.alts, true),
        optional: (n.q !== null && n.q.min === 0) || nullable(n.alts),
        alts: n.alts,
      })
    }
  }
  return out
}

/** True when some alternative can match the empty string. */
function nullable(alts: Node[][]): boolean {
  return alts.some((seq) =>
    seq.every(
      (n) =>
        n.t === "assert" ||
        n.t === "look" ||
        (n.q !== null && n.q.min === 0) ||
        (n.t === "group" && nullable(n.alts)),
    ),
  )
}

/** First (or last, when `fromEnd`) atoms a match of these alternatives can hold. */
function edges(alts: Node[][], fromEnd: boolean): Edge[] {
  const out: Edge[] = []
  for (const seq of alts) {
    const order = fromEnd ? [...seq].reverse() : seq
    for (const n of order) {
      if (n.t === "assert" || n.t === "look") continue
      const optional = n.q !== null && n.q.min === 0
      if (n.t === "atom") {
        out.push({ set: charSet(n.src), variable: variable(n.q) })
        if (!optional) break
      } else {
        out.push(...edges(n.alts, fromEnd))
        if (!optional && !nullable(n.alts)) break
      }
    }
  }
  return out
}

/**
 * A required group that a run of `setA` can absorb: every alternative holds only
 * assertions, optional atoms, or atoms that overlap `setA`.
 */
function transparent(alts: Node[][], setA: Uint8Array): boolean {
  return alts.every((seq) =>
    seq.every((n) => {
      if (n.t === "assert" || n.t === "look") return true
      if (n.q !== null && n.q.min === 0) return true
      if (n.t === "group") return transparent(n.alts, setA)
      const s = charSet(n.src)
      return s !== null && overlaps(setA, s)
    }),
  )
}

/** True when a variable atom overlapping `setA` can follow item `i` (see overlapInSeq). */
function overlapAfter(items: readonly Item[], i: number, setA: Uint8Array): boolean {
  for (let j = i + 1; j < items.length; j++) {
    const b = items[j] as Item
    if (b.t === "assert") continue
    if (b.t === "sum") {
      if (b.first.some((e) => e.variable && e.set !== null && overlaps(setA, e.set))) return true
      if (b.optional || transparent(b.alts, setA)) continue
      return false
    }
    const setB = charSet(b.src)
    if (setB === null) return false
    const over = overlaps(setA, setB)
    if (over && variable(b.q)) return true
    if (!over && (b.q === null || b.q.min > 0)) return false
  }
  return false
}

type ShapeFlags = {
  unbounded: boolean
  nested: boolean
  lazy: boolean
  huge: boolean
  overlap: boolean
}

function walk(alts: Node[][], f: ShapeFlags): void {
  for (const seq of alts) {
    if (!f.overlap && overlapInSeq(seq)) f.overlap = true
    for (const n of seq) {
      if (n.t === "assert") continue
      if (n.q !== null && n.q.max === null) f.unbounded = true
      if (n.q !== null && Math.max(n.q.min, n.q.max ?? 0) > HUGE_BOUND) f.huge = true
      if (n.t === "group" || n.t === "look") {
        if (
          n.q !== null &&
          (n.q.max === null || n.q.max > 1) &&
          ambiguousBody(n.alts) &&
          !safeRepeatBody(n.alts)
        )
          f.nested = true
        walk(n.alts, f)
      }
    }
  }
}

/**
 * True when the first real atom of any alternative is lazy. Assertions and lookarounds
 * are skipped (they consume nothing). Descends into groups.
 */
function leadingLazy(alts: Node[][]): boolean {
  for (const seq of alts) {
    const first = seq.find((n) => n.t !== "assert" && n.t !== "look")
    if (first === undefined) continue
    if (first.q?.lazy) return true
    if (first.t === "group" && leadingLazy(first.alts)) return true
  }
  return false
}

/**
 * Static shape check. Returns failure reasons. `notes` with "reviewed:<check>" opts out,
 * where check is "unbounded", "nested", "lazy-prefix", "huge-bound", or "overlap".
 */
export function staticShapeCheck(pattern: string, notes = ""): string[] {
  const out: string[] = []
  const { alts } = parseAlts(pattern, 0)
  const f: ShapeFlags = {
    unbounded: false,
    nested: false,
    lazy: leadingLazy(alts),
    huge: false,
    overlap: false,
  }
  walk(alts, f)
  if (f.overlap && !notes.includes("reviewed:overlap")) out.push("overlapping adjacent quantifiers")
  if (f.nested && !notes.includes("reviewed:nested")) out.push("nested quantifier")
  if (f.lazy && !notes.includes("reviewed:lazy-prefix")) out.push("leading lazy prefix")
  if (f.unbounded && !notes.includes("reviewed:unbounded")) out.push("unbounded quantifier")
  if (f.huge && !notes.includes("reviewed:huge-bound")) out.push("huge bound")
  return out
}

type Expanded = { text: string; secret: string | null }

function expand(ex: Example): Expanded {
  if (typeof ex === "string") return { text: ex, secret: null }
  return fillExample(ex.text, ex.secret)
}

const SAMPLE_TAGS: readonly (string | null)[] = ["1a2b3c4d", null]

/** A rendered example: the text and the [start, end) offsets of each marker in it. */
type MarkedText = { text: string; ranges: readonly (readonly [number, number])[] }

/**
 * Every marker text for one example value: each on level, with and without a tag.
 * Each output carries the offsets of its markers, so a scan can tell a hit on a marker
 * from a hit on plain example context (MJ1).
 */
function markedTexts(rule: RedactRule, text: string, value: string): MarkedText[] {
  const shape = rule.kind === "email" ? "email" : "token"
  const parts = text.split(value)
  const out: MarkedText[] = []
  const seen = new Set<string>()
  for (const level of LEVELS_ON)
    for (const tag of SAMPLE_TAGS) {
      const marker = renderMarker({
        value,
        kind: rule.kind,
        tag,
        level,
        render: rule.render,
        shape,
      })
      if (seen.has(marker)) continue
      seen.add(marker)
      const ranges: [number, number][] = []
      let s = parts[0] as string
      for (let k = 1; k < parts.length; k++) {
        ranges.push([s.length, s.length + marker.length])
        s += marker + (parts[k] as string)
      }
      out.push({ text: s, ranges })
    }
  return out
}

/** True when any hit overlaps any marker range. */
function hitsMarker(hits: readonly RuleHit[], ranges: MarkedText["ranges"]): boolean {
  return hits.some((h) => ranges.some(([s, e]) => h.start < e && h.end > s))
}

/** fix3 MAJOR 2a: max length of one expanded example, in chars. */
export const EXAMPLE_CAP = 8192

/** Check every example length without generating it. Returns failure reasons. */
function capExamples(rule: RedactRule): string[] {
  const out: string[] = []
  const one = (ex: Example, where: string): void => {
    let n = 0
    if (typeof ex === "string") n = ex.length
    else if (typeof ex?.text === "string" && typeof ex.secret?.len === "number") {
      const g = ex.secret
      const parts = ex.text.split("{{S}}")
      const value = g.len + (g.prefix ?? "").length + (g.suffix ?? "").length
      n = ex.text.length + (parts.length - 1) * (value - 5)
    } else n = Number.POSITIVE_INFINITY
    if (!(n <= EXAMPLE_CAP)) out.push(`${where}: example over ${EXAMPLE_CAP} chars`)
  }
  rule.examples.match.forEach((ex, i) => one(ex, `match[${i}]`))
  rule.examples.not_match.forEach((ex, i) => one(ex, `not_match[${i}]`))
  return out
}

/**
 * Strict CI bench budget (SPEC-v3 Performance, J section 4). 1 MB = 1e6 bytes.
 * bench.test.ts holds every real rule to this on a 1 MB corpus and its hostile texts.
 */
export const BENCH_MS_PER_MB = 50
/**
 * fix4 MAJOR 1: load-time bench budget, 5x looser than BENCH_MS_PER_MB. The load gate
 * runs on the user's machine, which can be slow or busy. It only has to catch
 * catastrophic rules (those grow far past any linear budget). A good rule that is near
 * the strict budget must not be disabled by noise. The strict 50 ms/MB stays in CI.
 */
export const LOAD_BENCH_MS_PER_MB = 250
/** fix4 MAJOR 1: retries are skipped only when the best run is also over this many ms. */
export const BENCH_SKIP_ABS_MS = 50
/** Load bench steps in chars. Grows by 4 so a catastrophic rule fails while still small. */
export const BENCH_STEPS: readonly number[] = [32, 128, 512, 2048, 8192, 65536]
/** Floor of the per-step budget: timer and JIT noise on tiny inputs. */
const BENCH_FLOOR_MS = 0.5
const BENCH_RUNS = 3

const FILLER_PREF = "aA0x=/ _-."
const BREAKER_PREF = "\u0001\n!~#\u00a7"

/** Atoms of a parsed pattern, at every depth. */
function atoms(alts: Node[][], out: Extract<Node, { t: "atom" }>[] = []): typeof out {
  for (const seq of alts)
    for (const n of seq) {
      if (n.t === "atom") out.push(n)
      else if (n.t === "group" || n.t === "look") atoms(n.alts, out)
    }
  return out
}

function setSize(s: Uint8Array): number {
  let n = 0
  for (let c = 0; c < s.length; c++) n += s[c] as number
  return n
}

/** A literal atom is one plain char: its set is computed cheaply. */
function literalChar(src: string | null): string | null {
  if (src === null) return null
  if (src.length === 1 && !".[]()|^$\\".includes(src)) return src
  if (src.length === 2 && src[0] === "\\" && /^[^\w\s]$/.test(src[1] as string))
    return src[1] as string
  return null
}

/** fix4 BLOCKER 1b: max number of hostile texts (distinct variable-atom char sets). */
export const HOSTILE_SET_CAP = 8

function fillerOf(s: Uint8Array): string {
  const pick = FILLER_PREF.split("").find((ch) => s[ch.charCodeAt(0)] === 1)
  return pick ?? String.fromCharCode(s.indexOf(1))
}

/**
 * Hostile texts built from the rule's own pattern, each of length n. Each text is the
 * leading literal prefix, then a run of one filler char, then the same again, then one
 * breaker char that is in no class of the pattern (it fails the match at the end).
 *
 * fix4 BLOCKER 1b: one text per distinct variable-atom char set (min != max), each with
 * that set's own filler char and the shared breaker. A slow run in a narrow class (like
 * `[0-9]{1,300}` next to a wider `[A-Za-z!]?`) gets its own text. The widest set comes
 * first. At most HOSTILE_SET_CAP texts. With no variable atom, the widest class is used.
 *
 * fix4 MINOR 2: the prefix is taken only when the pattern has one top-level
 * alternative. With an empty prefix and a top-level alternation (`a{1,9}x|b{1,9}y`), the
 * texts skip the leading literal of every branch, so a branch that needs a literal
 * before its runs is only reached when its run char happens to be a filler. Low risk:
 * every variable set still gets a filler run, and the CI bench adds a mixed corpus.
 */
export function hostileTexts(rule: RedactRule, n: number): string[] {
  const { alts } = parseAlts(rule.pattern ?? "", 0)
  const first = alts.length === 1 ? (alts[0] as Node[]) : []
  let prefix = ""
  for (const node of first) {
    if (node.t === "assert") continue
    const ch = node.t === "atom" && node.q === null ? literalChar(node.src) : null
    if (ch === null) break
    prefix += ch
  }
  const union = new Uint8Array(0x10000)
  let widest: Uint8Array | null = null
  let widestN = 0
  const varSets: { set: Uint8Array; size: number }[] = []
  for (const a of atoms(alts)) {
    const ch = literalChar(a.src)
    if (ch !== null) {
      union[ch.toLowerCase().charCodeAt(0)] = 1
      union[ch.toUpperCase().charCodeAt(0)] = 1
      if (!variable(a.q)) continue
    }
    const s = charSet(a.src)
    if (s === null) continue
    if (ch === null) for (let c = 0; c < s.length; c++) if (s[c] === 1) union[c] = 1
    const size = setSize(s)
    if (variable(a.q) && !varSets.some((v) => v.set === s)) varSets.push({ set: s, size })
    if (ch === null && size > widestN) {
      widest = s
      widestN = size
    }
  }
  const fillers: string[] = []
  const sets = varSets.length > 0 ? varSets : widest !== null ? [{ set: widest, size: 0 }] : []
  for (const v of [...sets].sort((x, y) => y.size - x.size)) {
    const f = fillerOf(v.set)
    if (!fillers.includes(f)) fillers.push(f)
    if (fillers.length >= HOSTILE_SET_CAP) break
  }
  if (fillers.length === 0) fillers.push("a")
  const breaker = BREAKER_PREF.split("").find((ch) => union[ch.charCodeAt(0)] !== 1) ?? "\u0001"
  const half = Math.floor(n / 2)
  return fillers.map((filler) => {
    const part = (len: number): string =>
      len <= prefix.length ? prefix.slice(0, len) : prefix + filler.repeat(len - prefix.length)
    return part(half) + part(Math.max(0, n - half - 1)) + (n > half ? breaker : "")
  })
}

/** The first hostile text (widest variable set). See hostileTexts. */
export function hostileText(rule: RedactRule, n: number): string {
  return hostileTexts(rule, n)[0] as string
}

/**
 * fix4 MAJOR 1: skip the retries only when the best run is over 10x the budget AND over
 * BENCH_SKIP_ABS_MS. A single GC or JIT pause on a small step stays under that.
 */
export function benchSkipRetries(best: number, budget: number): boolean {
  return best > budget * 10 && best > BENCH_SKIP_ABS_MS
}

export type BenchResult =
  | { ok: true; msPerMb: number }
  | { ok: false; reason: string; msPerMb: number }

function bestOf(c: CompiledRedactRule, text: string, budget: number): number {
  let best = Number.POSITIVE_INFINITY
  for (let r = 0; r < BENCH_RUNS; r++) {
    const t0 = performance.now()
    scanRule(c, text, { raw: true })
    const ms = performance.now() - t0
    if (ms < best) best = ms
    // Under budget: done. Far over budget (fix4: also over 50 ms): skip the retries.
    if (best <= budget || benchSkipRetries(best, budget)) break
  }
  return best
}

/**
 * fix3 MAJOR 2b: load-time bench. Runs the rule alone on its hostile texts (fix4: one
 * per variable char set) of growing size up to 64 KB. Fails when the best of 3 runs on
 * ANY text costs more than `msPerMb` (default LOAD_BENCH_MS_PER_MB, 250 ms/MB, floor
 * 0.5 ms for tiny inputs). CI uses the strict BENCH_MS_PER_MB (50 ms/MB) in
 * bench.test.ts. Steps grow by 4, so a polynomial rule fails at a small size and the
 * loader does not hang. Sync, never throws.
 */
export function benchRule(
  c: CompiledRedactRule,
  steps = BENCH_STEPS,
  msPerMb = LOAD_BENCH_MS_PER_MB,
): BenchResult {
  try {
    if (c.re === null) return { ok: true, msPerMb: 0 }
    scanRule(c, "warm up a", { raw: true })
    // msPerMb of the last (largest) step: small steps are dominated by timer noise.
    let last = 0
    for (const n of steps) {
      const budget = Math.max(BENCH_FLOOR_MS, (n * msPerMb) / 1e6)
      let worst = 0
      for (const text of hostileTexts(c.rule, n)) {
        const ms = bestOf(c, text, budget)
        if (ms > worst) worst = ms
        if (ms > budget)
          return {
            ok: false,
            reason: `bench: ${ms.toFixed(2)} ms on ${n} hostile chars (budget ${budget.toFixed(2)} ms, ${msPerMb} ms/MB)`,
            msPerMb: (ms * 1e6) / n,
          }
      }
      last = (worst * 1e6) / n
    }
    return { ok: true, msPerMb: last }
  } catch (e) {
    return {
      ok: false,
      reason: `bench internal: ${e instanceof Error ? e.message : String(e)}`,
      msPerMb: 0,
    }
  }
}

function checkRedact(rule: RedactRule): string[] {
  const fails: string[] = []
  if (rule.family !== "secret" && rule.family !== "pii") fails.push("family must be secret or pii")
  for (const k of rule.keywords)
    if (k !== k.toLowerCase()) fails.push(`keyword not lowercase: ${k}`)
  if (rule.gate === "keyword") {
    if (rule.keywords.length === 0) fails.push("keyword gate needs keywords")
    const short = rule.keywords.filter((k) => k.length < 3)
    if (short.length > 0)
      fails.push(`keyword gate needs every keyword 3+ chars: ${short.join(",")}`)
  }
  // fix3 MINOR 2: every gate other than "keyword" (also "always") needs a reason.
  if (rule.gate !== "keyword" && (rule.notes ?? "").trim() === "") {
    fails.push(`gate "${rule.gate}" needs a reason in notes`)
  }
  if (rule.pattern === undefined) {
    if (rule.knownValue === undefined) fails.push("no pattern and no knownValue")
    // fix4 MINOR 1: compileRedactRule owns the allowlist checks. Run it here too, since
    // the pattern path below is skipped.
    const c = compileRedactRule(rule)
    if (typeof c === "string") fails.push(c)
    return fails
  }
  const shape = staticShapeCheck(rule.pattern, rule.notes)
  fails.push(...shape)
  const compiled = compileRedactRule(rule)
  if (typeof compiled === "string") return [...fails, compiled]
  const automaton = buildAutomaton(rule.keywords)

  // fix3 MAJOR 2a: cap every example before it is generated or scanned.
  const capped = capExamples(rule)
  if (capped.length > 0) return [...fails, ...capped]
  // fix3 MAJOR 2b: load-time bench. Skipped when the static check failed (a flagged
  // shape can hang the bench, and the rule is disabled anyway).
  if (shape.length === 0) {
    const b = benchRule(compiled)
    if (!b.ok) return [...fails, b.reason]
  }

  const matches = rule.examples.match.map(expand)
  const misses = rule.examples.not_match.map(expand)
  if (matches.length === 0) fails.push("no match examples")

  matches.forEach((ex, i) => {
    const hits = scanRule(compiled, ex.text)
    const hit = hits[0]
    if (hits.length !== 1) fails.push(`match[${i}]: ${hits.length} spans, want 1`)
    else if (ex.secret !== null && hit?.value !== ex.secret)
      fails.push(`match[${i}]: span is not the secret`)
    if (rule.gate === "keyword") {
      const kh = automaton.scan(ex.text)
      const near =
        hit === undefined
          ? kh.length > 0
          : kh.some(
              (k) => k.end >= hit.start - KEYWORD_WINDOW && k.start <= hit.end + KEYWORD_WINDOW,
            )
      if (!near)
        fails.push(`match[${i}]: no keyword within ${KEYWORD_WINDOW} chars (prefilter invariant)`)
    }
    const value = ex.secret ?? hit?.value
    if (
      value !== undefined &&
      rule.render.publicPrefix !== undefined &&
      !value.startsWith(rule.render.publicPrefix)
    ) {
      fails.push(`match[${i}]: publicPrefix is not a prefix of the secret`)
    }
    // Marker safety on the rendered example at every level, with and without a tag.
    if (value !== undefined) {
      for (const out of markedTexts(rule, ex.text, value)) {
        if (hitsMarker(scanRule(compiled, out.text), out.ranges)) {
          fails.push(`match[${i}]: marker gives a span`)
          break
        }
      }
    }
  })

  misses.forEach((ex, i) => {
    const n = scanRule(compiled, ex.text).length
    if (n !== 0) fails.push(`not_match[${i}]: ${n} spans, want 0`)
  })

  if (rule.validator !== undefined || rule.entropy !== undefined) {
    const v = rule.validator !== undefined ? VALIDATORS[rule.validator] : null
    const okv = (s: string): boolean =>
      (v === null || v(s)) && (rule.entropy === undefined || shannon(s) >= rule.entropy.min)
    for (const [i, ex] of matches.entries()) {
      for (const h of scanRule(compiled, ex.text, { raw: true })) {
        if (!okv(h.value)) fails.push(`match[${i}]: fails validator or entropy`)
      }
    }
    const nearMissFails = misses.some((ex) =>
      scanRule(compiled, ex.text, { raw: true }).some((h) => !okv(h.value)),
    )
    if (!nearMissFails) fails.push("no not_match near miss fails the validator or entropy")
  }

  for (const s of markerSamples(rule.kind)) {
    if (scanRule(compiled, s).length !== 0)
      fails.push(`marker sample gives a span: ${s.slice(0, 40)}`)
  }
  return fails
}

/**
 * Registry-level marker safety (SPEC-v3: every marker shape through the full rule set).
 * Renders every rule's match examples at every on level, with and without a tag, plus
 * the fixed marker samples, and scans them with ALL rules. Returns one entry per rule
 * that gives a span on any marker text. Never throws.
 */
export function markerSafety(
  compiled: readonly CompiledRedactRule[],
): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = []
  try {
    const scanners = compiled.filter((c) => c.re !== null)
    const owners = new Map<string, number[]>()
    const ungated: number[] = []
    scanners.forEach((c, i) => {
      if (c.rule.gate !== "keyword") ungated.push(i)
      else
        for (const k of c.rule.keywords) {
          const list = owners.get(k)
          if (list) list.push(i)
          else owners.set(k, [i])
        }
    })
    const automaton = buildAutomaton([...owners.keys()])
    const flagged = new Set<number>()
    // ranges null: the whole text is a marker (fixed samples). Otherwise only a hit
    // that overlaps a marker range counts, not a hit on plain example context (MJ1).
    const scanText = (text: string, ranges: MarkedText["ranges"] | null, source: string): void => {
      const present = automaton.present(text)
      const cand = new Set(ungated)
      automaton.keywords.forEach((k, ki) => {
        if (present[ki] === 1) for (const i of owners.get(k) ?? []) cand.add(i)
      })
      for (const i of cand) {
        if (flagged.has(i)) continue
        const c = scanners[i] as CompiledRedactRule
        const hits = scanRule(c, text, { limit: ranges === null ? 1 : 10000 })
        if (ranges === null ? hits.length > 0 : hitsMarker(hits, ranges)) {
          flagged.add(i)
          out.push({ id: c.rule.id, reason: `marker safety: matches ${source}` })
        }
      }
    }
    for (const a of compiled) {
      const r = a.rule
      for (const s of markerSamples(r.kind)) scanText(s, null, `a marker sample of ${r.id}`)
      if (a.re === null) continue
      for (const ex of r.examples.match.map(expand)) {
        const value = ex.secret ?? scanRule(a, ex.text, { limit: 1 })[0]?.value
        if (value === undefined) continue
        for (const t of markedTexts(r, ex.text, value))
          scanText(t.text, t.ranges, `a marker of ${r.id}`)
      }
    }
  } catch (e) {
    out.push({
      id: "*",
      reason: `marker safety internal: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
  return out
}

/** Path match: returns true when the canonicalized path matches. Injected by the guard. */
export type PathMatcher = (rule: PathRule, path: string) => boolean
/** Command evaluator: returns the decision for a line, or null. Injected by the guard. */
export type CmdEvaluator = (rule: CmdRule, line: string) => CmdDecision | null

export type SelfTestHooks = { pathMatcher?: PathMatcher; cmdEvaluator?: CmdEvaluator }

function checkCommon(rule: AnyRule): string[] {
  const fails: string[] = []
  if (typeof rule.explain !== "string" || rule.explain.length === 0) fails.push("empty explain")
  else if (rule.explain.length > 120 || /[\r\n]/.test(rule.explain))
    fails.push("explain must be one line of 120 chars or less")
  return fails
}

function checkPath(rule: PathRule, m?: PathMatcher): string[] {
  const fails: string[] = []
  if (rule.globs.length === 0) fails.push("no globs")
  if (m === undefined) return fails
  rule.examples.match.forEach((p, i) => {
    if (!m(rule, p)) fails.push(`match[${i}]: path does not match`)
  })
  rule.examples.not_match.forEach((p, i) => {
    if (m(rule, p)) fails.push(`not_match[${i}]: path matches`)
  })
  return fails
}

function checkCmd(rule: CmdRule, e?: CmdEvaluator): string[] {
  const fails: string[] = []
  if (typeof rule.match !== "function") fails.push("match is not a function")
  if (e === undefined) return fails
  rule.examples.match.forEach((l, i) => {
    if (e(rule, l) !== rule.decision) fails.push(`match[${i}]: no ${rule.decision}`)
  })
  rule.examples.not_match.forEach((l, i) => {
    if (e(rule, l) !== null) fails.push(`not_match[${i}]: hit`)
  })
  return fails
}

/** Self-test one rule. Sync, pure, never throws. */
export function selfTest(rule: AnyRule, hooks: SelfTestHooks = {}): SelfTestResult {
  const id = typeof rule?.id === "string" ? rule.id : "<no id>"
  try {
    const fails = checkCommon(rule)
    if (rule.family === "path") fails.push(...checkPath(rule, hooks.pathMatcher))
    else if (rule.family === "cmd") fails.push(...checkCmd(rule, hooks.cmdEvaluator))
    else fails.push(...checkRedact(rule))
    return fails.length === 0 ? { id, ok: true } : { id, ok: false, reason: fails.join("; ") }
  } catch (e) {
    return {
      id,
      ok: false,
      reason: `selftest internal: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
