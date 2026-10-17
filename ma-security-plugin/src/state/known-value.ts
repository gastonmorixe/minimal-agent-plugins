// Session known-value index (SPEC-v3 "Known-value index", "Bounded stores").
// Each value is indexed in 4 forms: raw, base64, base64url, URL-encoded. Each value has a
// match mode (D9): "substring" or "token". find() is one pass over the text: a rolling
// hash of the first ANCHOR code units of each form, checked at EVERY position (substring
// values may start anywhere), then an exact startsWith plus the boundary check of the
// value's mode. Candidates are then merged (no overlap). There is NO marker skip (D16):
// model text could shield a value with one bracket. Idempotency comes from add(): a value
// that hits a real marker shape is refused, and a test proves every marker shape gives
// zero hits. Add and remove are incremental (no rebuild). Values live in memory only.
// Sync only. Never throws out of a public method. Never logs.

import { isRandomLooking, RANDOM_MIN_LEN } from "../engine/random.ts"
import { markerSamples } from "../redact/markers.ts"

import type {
  KnownValueClass,
  KnownValueEncoding,
  KnownValueEntry,
  KnownValueHit,
  KnownValueIndex,
  KnownValueMeta,
  KnownValueMode,
  KnownValueSource,
  SessionKey,
} from "./types.ts"
import { isWholeTokenAt } from "./types.ts"

/** SPEC floor. A lower configured min_len is raised to this. */
export const MIN_LEN_FLOOR = 8
/**
 * `known-value:max_derived` default. Equal to the vault cap (vault.ts
 * DEFAULT_VAULT_MAX_ENTRIES, 50000) so the two stores never drift (M4). A test pins it.
 */
export const DEFAULT_MAX_DERIVED = 50000
/** Hash window. Equal to the floor, so every indexed form is at least this long. */
const ANCHOR = 8
const BASE = 0x01000193
const FILTER_BITS = 16

/**
 * Minimum length for substring mode (D9). Same as the engine gate length
 * (src/engine/random.ts RANDOM_MIN_LEN, the one definition per D14).
 */
export const SUBSTRING_MIN_LEN = RANDOM_MIN_LEN

/** Class of a value: the meta class, else "identity" for a `pii.` rule, else "secret". */
export function classOf(meta: KnownValueMeta): KnownValueClass {
  if (meta.class === "identity" || meta.class === "secret") return meta.class
  return typeof meta.ruleId === "string" && meta.ruleId.startsWith("pii.") ? "identity" : "secret"
}

/**
 * Match mode (D9, SPEC-v3 "Known-value index"):
 * - identity values: token
 * - harness credential-file secrets: substring when length is 20 or more (no gate), else token
 * - env and vault-derived values: substring when isRandomLooking, else token
 * - a value that holds `@` is token from every source (an email is identity, N2)
 * A value that fails the gate is still matched, in token mode.
 */
export function modeOf(value: string, meta: KnownValueMeta): KnownValueMode {
  if (classOf(meta) === "identity") return "token"
  if (value.includes("@")) return "token"
  if (meta.source === "harness") return value.length >= SUBSTRING_MIN_LEN ? "substring" : "token"
  return isRandomLooking(value) ? "substring" : "token"
}

/** "substring" is stronger than "token" (it matches more). */
function strongerMode(a: KnownValueMode, b: KnownValueMode): KnownValueMode {
  return a === "substring" || b === "substring" ? "substring" : "token"
}

/** Fixed marker text per kind (markerSamples of the kind plus "email"). Cached. */
const markerCorpus = new Map<string, string>()
function corpusFor(kind: string): string {
  const k = typeof kind === "string" ? kind : ""
  let c = markerCorpus.get(k)
  if (c === undefined) {
    c = ` ${[...markerSamples(k), ...markerSamples("email")].join(" ")} `
    if (markerCorpus.size < 1024) markerCorpus.set(k, c)
  }
  return c
}

/** Thrown by a loader to report a safe message (never a value). Other errors are named only. */
export class KnownValueLoadError extends Error {
  override name = "KnownValueLoadError"
}

export type KnownValueIndexOptions = {
  key: SessionKey
  /** `known-value:min_len`. Raised to MIN_LEN_FLOOR. A non-integer is rejected (floor used). */
  minLen?: number
  /** `known-value:max_derived`. Default 50000 (the vault cap). Null turns the cap off. */
  maxDerived?: number | null
}

/** The 4 indexed forms of a value. */
export function encodingsOf(value: string): Record<KnownValueEncoding, string> {
  const buf = Buffer.from(value, "utf8")
  return {
    raw: value,
    base64: buf.toString("base64"),
    base64url: buf.toString("base64url"),
    url: urlEncode(value),
  }
}

/** encodeURIComponent throws on a lone surrogate. Fall back to the raw form then. */
function urlEncode(value: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    return value
  }
}

const ENCODINGS: readonly KnownValueEncoding[] = ["raw", "base64", "base64url", "url"]

type Pattern = {
  text: string
  encoding: KnownValueEncoding
  node: Node
  hash: number
  /** The form has no `/`: in token mode `/` also counts as a boundary. */
  slashFree: boolean
}

type Node = {
  entry: KnownValueEntry
  patterns: Pattern[]
}

function anchorHash(s: string, at: number): number {
  let h = 0
  for (let k = 0; k < ANCHOR; k++) h = (Math.imul(h, BASE) + s.charCodeAt(at + k)) | 0
  return h
}

function filterSlot(h: number): number {
  return (h ^ (h >>> FILTER_BITS)) & ((1 << FILTER_BITS) - 1)
}

/** BASE^(ANCHOR-1) mod 2^32, for the rolling update. */
const BASE_TOP = (() => {
  let p = 1
  for (let k = 0; k < ANCHOR - 1; k++) p = Math.imul(p, BASE)
  return p
})()

function isTokenCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === 43 ||
    c === 47 ||
    c === 45
  )
}

/** Token mode boundary: isWholeTokenAt, plus `/` as a boundary for a form with no `/`. */
function tokenBoundaryOk(text: string, start: number, end: number, slashFree: boolean): boolean {
  if (isWholeTokenAt(text, start, end)) return true
  if (!slashFree) return false
  if (start > 0) {
    const c = text.charCodeAt(start - 1)
    if (c !== 47 && isTokenCode(c)) return false
  }
  if (end < text.length) {
    const c = text.charCodeAt(end)
    if (c !== 47 && isTokenCode(c)) return false
  }
  return true
}

type Cand = { start: number; end: number; best: Pattern }

/** True when any form of the node matches in text, with the node's mode rules (find() logic). */
function hitsIn(node: Node, text: string, mode: KnownValueMode = node.entry.mode): boolean {
  const token = mode === "token"
  for (const p of node.patterns) {
    let at = text.indexOf(p.text)
    while (at >= 0) {
      if (!token || tokenBoundaryOk(text, at, at + p.text.length, p.slashFree)) return true
      at = text.indexOf(p.text, at + 1)
    }
  }
  return false
}

function safeError(e: unknown): string {
  if (e instanceof KnownValueLoadError) return e.message
  const name = e instanceof Error ? e.name : typeof e
  return `load failed: ${name}`
}

class Index implements KnownValueIndex {
  readonly #key: SessionKey
  readonly #minLen: number
  #maxDerived: number | null
  #derivedEvictions = 0
  /** Tags that now hold 2 or more distinct values (D13). */
  #ambiguousTags = 0
  #lastLoadError: string | null = null
  readonly #byValue = new Map<string, Node>()
  readonly #byTag = new Map<string, Node[]>()
  /** Derived nodes in LRU order (oldest first). Keyed by value. */
  readonly #derived = new Map<string, Node>()
  readonly #buckets = new Map<number, Pattern[]>()
  readonly #filter = new Uint32Array(1 << FILTER_BITS)
  readonly #counts: Record<KnownValueSource, number> = { harness: 0, env: 0, vault: 0 }
  readonly #modeCounts: Record<KnownValueMode, number> = { substring: 0, token: 0 }

  constructor(o: KnownValueIndexOptions) {
    this.#key = o.key
    this.#minLen = Math.max(MIN_LEN_FLOOR, Number.isInteger(o.minLen) ? (o.minLen as number) : 0)
    this.#maxDerived = o.maxDerived === undefined ? DEFAULT_MAX_DERIVED : capOf(o.maxDerived)
  }

  get size(): number {
    return this.#byValue.size
  }
  get maxDerived(): number | null {
    return this.#maxDerived
  }
  get derivedEvictions(): number {
    return this.#derivedEvictions
  }
  get tagCollisions(): number {
    return this.#ambiguousTags
  }
  get lastLoadError(): string | null {
    return this.#lastLoadError
  }

  sources(): Readonly<Record<KnownValueSource, number>> {
    return { ...this.#counts }
  }

  modes(): Readonly<Record<KnownValueMode, number>> {
    return { ...this.#modeCounts }
  }

  add(value: string, meta: KnownValueMeta): boolean {
    try {
      return this.#add(value, meta) !== "skip"
    } catch {
      return false
    }
  }

  /**
   * Re-add of a known value. A vault entry is touched (vault meta) or promoted (harness
   * or env, never evicted). For a secret-class meta the mode is recomputed and the
   * stronger one kept (N1), so the result does not depend on load order. Source and
   * class only move up: vault to harness or env, identity to secret.
   */
  #readd(old: Node, meta: KnownValueMeta): void {
    const e = old.entry
    const value = e.value
    let source = e.source
    if (e.source === "vault") {
      if (meta.source === "vault") {
        // Touch: move to the LRU tail.
        this.#derived.delete(value)
        this.#derived.set(value, old)
      } else {
        // Promote: harness and env are never evicted.
        this.#derived.delete(value)
        source = meta.source
      }
    }
    const secretMeta = classOf(meta) === "secret"
    let mode = secretMeta ? strongerMode(e.mode, modeOf(value, meta)) : e.mode
    // D16: a raise to substring must not make the value hit a real marker shape.
    if (
      mode !== e.mode &&
      (hitsIn(old, corpusFor(e.kind), mode) || hitsIn(old, corpusFor(meta.kind), mode))
    ) {
      mode = e.mode
    }
    const promoted = source !== e.source
    const raised = mode !== e.mode
    if (!promoted && !raised) return
    // The new meta wins for rule and kind when it promotes or raises the mode.
    const next: KnownValueEntry = Object.freeze({
      value,
      tag: e.tag,
      // An identity meta never turns a secret entry into a `pii.` rule.
      ruleId: secretMeta || e.class === "identity" ? meta.ruleId : e.ruleId,
      kind: secretMeta || e.class === "identity" ? meta.kind : e.kind,
      source,
      mode,
      class: secretMeta ? "secret" : e.class,
    })
    this.#counts[e.source]--
    this.#counts[source]++
    this.#modeCounts[e.mode]--
    this.#modeCounts[mode]++
    old.entry = next
  }

  /** "new", "old" (already there), or "skip" (under the floor, a marker hit, bad input). */
  #add(value: string, meta: KnownValueMeta): "new" | "old" | "skip" {
    if (typeof value !== "string" || value.length < this.#minLen) return "skip"
    const old = this.#byValue.get(value)
    if (old !== undefined) {
      this.#readd(old, meta)
      return "old"
    }
    let tag: string
    try {
      tag = this.#key.tag(value) ?? ""
    } catch {
      tag = ""
    }
    const node: Node = { entry: freeze(value, tag, meta), patterns: [] }
    const seen = new Set<string>()
    const enc = encodingsOf(value)
    for (const e of ENCODINGS) {
      const text = enc[e]
      if (seen.has(text) || text.length < ANCHOR) continue
      seen.add(text)
      const p: Pattern = {
        text,
        encoding: e,
        node,
        hash: anchorHash(text, 0),
        slashFree: !text.includes("/"),
      }
      node.patterns.push(p)
    }
    // D16: a value that hits a real marker shape would break idempotency. Refuse it.
    if (hitsIn(node, corpusFor(meta.kind))) return "skip"
    for (const p of node.patterns) {
      const b = this.#buckets.get(p.hash)
      if (b === undefined) this.#buckets.set(p.hash, [p])
      else b.push(p)
      this.#filter[filterSlot(p.hash)]++
    }
    this.#byValue.set(value, node)
    // An empty tag (HMAC failed) is never indexed by tag: the value still matches by value.
    if (tag !== "") {
      const list = this.#byTag.get(tag)
      if (list === undefined) this.#byTag.set(tag, [node])
      else {
        // Values are unique in #byValue, so every node in the list is a distinct value.
        list.push(node)
        if (list.length === 2) this.#ambiguousTags++
      }
    }
    this.#counts[meta.source]++
    this.#modeCounts[node.entry.mode]++
    if (meta.source === "vault") {
      this.#derived.set(value, node)
      this.#enforceCap()
    }
    return "new"
  }

  #drop(node: Node): void {
    const value = node.entry.value
    this.#byValue.delete(value)
    this.#derived.delete(value)
    const list = this.#byTag.get(node.entry.tag)
    if (list !== undefined) {
      const rest = list.filter((n) => n !== node)
      if (list.length >= 2 && rest.length < 2) this.#ambiguousTags--
      if (rest.length === 0) this.#byTag.delete(node.entry.tag)
      else this.#byTag.set(node.entry.tag, rest)
    }
    for (const p of node.patterns) {
      const b = this.#buckets.get(p.hash)
      if (b !== undefined) {
        const rest = b.filter((x) => x !== p)
        if (rest.length === 0) this.#buckets.delete(p.hash)
        else this.#buckets.set(p.hash, rest)
      }
      this.#filter[filterSlot(p.hash)]--
    }
    this.#counts[node.entry.source]--
    this.#modeCounts[node.entry.mode]--
  }

  #enforceCap(): void {
    const cap = this.#maxDerived
    if (cap === null) return
    while (this.#derived.size > cap) {
      const first = this.#derived.values().next()
      if (first.done) return
      this.#drop(first.value)
      this.#derivedEvictions++
    }
  }

  setDerivedCap(n: number | null): void {
    try {
      this.#maxDerived = capOf(n)
      this.#enforceCap()
    } catch {
      // never throw
    }
  }

  /** By tag. An ambiguous tag (D13) removes nothing: the caller must remove by value. */
  removeDerived(tag: string): boolean {
    try {
      const list = this.#byTag.get(tag)
      if (list === undefined || list.length !== 1) return false
      const node = list[0]
      if (node === undefined || node.entry.source !== "vault") return false
      this.#drop(node)
      return true
    } catch {
      return false
    }
  }

  removeDerivedValue(value: string): boolean {
    try {
      const node = this.#byValue.get(value)
      if (node === undefined || node.entry.source !== "vault") return false
      this.#drop(node)
      return true
    } catch {
      return false
    }
  }

  lookupValue(value: string): KnownValueEntry | undefined {
    try {
      return this.#byValue.get(value)?.entry
    } catch {
      return undefined
    }
  }

  /** Undefined for an unknown tag and for an ambiguous tag (2 or more distinct values). */
  lookupTag(tag: string): KnownValueEntry | undefined {
    try {
      const list = this.#byTag.get(tag)
      return list !== undefined && list.length === 1 ? list[0]?.entry : undefined
    } catch {
      return undefined
    }
  }

  reload(
    source: KnownValueSource,
    load: () => readonly { value: string; meta: KnownValueMeta }[],
  ): { added: number } | { error: string } {
    let items: readonly { value: string; meta: KnownValueMeta }[]
    try {
      items = load()
      if (!Array.isArray(items)) throw new KnownValueLoadError("load failed: not a list")
    } catch (e) {
      const error = safeError(e)
      this.#lastLoadError = error
      return { error }
    }
    let added = 0
    try {
      for (const it of items) {
        if (it === null || typeof it !== "object") continue
        const meta: KnownValueMeta = { ...it.meta, source }
        if (this.#add(it.value, meta) === "new") added++
      }
    } catch (e) {
      const error = safeError(e)
      this.#lastLoadError = error
      return { error }
    }
    this.#lastLoadError = null
    return { added }
  }

  find(text: string): KnownValueHit[] {
    const cands: Cand[] = []
    try {
      const n = typeof text === "string" ? text.length : 0
      if (n < ANCHOR || this.#buckets.size === 0) return []
      const filter = this.#filter
      const buckets = this.#buckets
      let h = anchorHash(text, 0)
      // Every position: substring-mode values may start anywhere.
      for (let i = 0; ; i++) {
        if (filter[filterSlot(h)] !== 0) {
          const b = buckets.get(h)
          if (b !== undefined) {
            let best: Pattern | undefined
            for (const p of b) {
              const len = p.text.length
              if (best !== undefined && len <= best.text.length) continue
              if (i + len > n || !text.startsWith(p.text, i)) continue
              if (p.node.entry.mode === "token" && !tokenBoundaryOk(text, i, i + len, p.slashFree))
                continue
              best = p
            }
            if (best !== undefined) cands.push({ start: i, end: i + best.text.length, best })
          }
        }
        if (i + ANCHOR >= n) break
        const out = text.charCodeAt(i)
        h = (Math.imul(h - Math.imul(out, BASE_TOP), BASE) + text.charCodeAt(i + ANCHOR)) | 0
      }
    } catch {
      // never throw: return what was found
    }
    try {
      return mergeHits(text, cands)
    } catch {
      return []
    }
  }
}

/**
 * Merge overlaps. A merged hit covers the union of its members and carries the metadata
 * of the longest member. Input is sorted by start. No marker skip (D16).
 */
function mergeHits(text: string, cands: readonly Cand[]): KnownValueHit[] {
  const hits: KnownValueHit[] = []
  if (cands.length === 0) return hits
  let cur: Cand | undefined
  const flush = (c: Cand): void => {
    const e = c.best.node.entry
    hits.push({
      start: c.start,
      end: c.end,
      ruleId: e.ruleId,
      kind: e.kind,
      value: text.slice(c.start, c.end),
      layer: "known-value",
      tag: e.tag,
      encoding: c.best.encoding,
      entry: e,
    })
  }
  for (const c of cands) {
    if (cur !== undefined && c.start < cur.end) {
      const bestLen = c.best.text.length > cur.best.text.length ? c.best : cur.best
      cur = { start: cur.start, end: Math.max(cur.end, c.end), best: bestLen }
      continue
    }
    if (cur !== undefined) flush(cur)
    cur = c
  }
  if (cur !== undefined) flush(cur)
  return hits
}

function capOf(n: number | null): number | null {
  if (n === null) return null
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_DERIVED
}

function freeze(value: string, tag: string, meta: KnownValueMeta): KnownValueEntry {
  return Object.freeze({
    value,
    tag,
    ruleId: meta.ruleId,
    kind: meta.kind,
    source: meta.source,
    mode: modeOf(value, meta),
    class: classOf(meta),
  })
}

/** New empty index bound to the session key (tags match the vault and the redactor). */
export function createKnownValueIndex(o: KnownValueIndexOptions): KnownValueIndex {
  return new Index(o)
}
