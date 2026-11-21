import { readLegacyText } from "./legacy-text.ts"
import { v1AttrDeclName } from "./levels.ts"
import { decodeBackslash, decodeRefs } from "./refs.ts"
import type {
  ReadonlySidebandRegistry,
  SidebandKind,
  SidebandNode,
  SidebandParseOptions,
} from "./types.ts"

const SEG = "[A-Za-z0-9_][A-Za-z0-9_.-]*"
const MA_RE = new RegExp(`ma(?::${SEG}|(?:::${SEG})+)`, "iy")
const BARE_RE = /(?:mode-change|memory-saved|short-term-memory|tui-preview)(?![A-Za-z0-9_.-])/iy
const ATTR_RE = new RegExp(SEG, "y")
const WS_RE = /[ \t\r\n]/
const BARE_NAMES = ["mode-change", "memory-saved", "short-term-memory", "tui-preview"]
// Longest text that can still be an opener prefix ("ma::" or a bare name).
// A longer rest cannot be a prefix, so the check never reads past it (M1).
const PREFIX_MAX = Math.max("ma::".length, ...BARE_NAMES.map((n) => n.length))
const KIND_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const A2: Record<string, string> = { "ma::plugin::memory::short-term": "short-term-memory" }
const LEVELS = new Set(["agent", "emit", "sys", "context", "plugin"])
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g

/** Lookup data a parse run needs from the registry. */
export interface ParseContext {
  /** Lowercase legacy qname to kind name (table L1 step 1). */
  legacy: Map<string, string>
  /** Find a registered kind. */
  kind(name: string): SidebandKind | undefined
}

/** Result of one parse attempt at a `<` position. */
export type ParseAtResult =
  | { status: "node"; node: SidebandNode; end: number }
  | { status: "none" }
  | { status: "incomplete"; phase: "open" | "body" }

/** Build a parse context from a read-only registry view. */
export function makeContext(registry: ReadonlySidebandRegistry): ParseContext {
  const legacy = new Map<string, string>()
  for (const k of registry.kinds()) {
    for (const alias of k.legacy ?? []) legacy.set(alias.toLowerCase(), k.kind)
  }
  return { legacy, kind: (name) => registry.kind(name) }
}

interface QnameHit {
  text: string
  end: number
}

/** Match a qname at `at` (v1, v2 or bare). */
export function matchQname(text: string, at: number): QnameHit | undefined {
  MA_RE.lastIndex = at
  const m = MA_RE.exec(text)
  if (m) return { text: m[0], end: at + m[0].length }
  BARE_RE.lastIndex = at
  const b = BARE_RE.exec(text)
  if (b) return { text: b[0], end: at + b[0].length }
  return undefined
}

/** True when `text` from `at` to its end is a strict start of an opener name. */
function isOpenerPrefix(text: string, at: number): boolean {
  if (text.length - at > PREFIX_MAX) return false
  const low = text.slice(at).toLowerCase()
  if (/^ma:{0,2}$/.test(low)) return true
  return BARE_NAMES.some((n) => n.startsWith(low))
}

function normalizeKind(raw: string): string | undefined {
  const name = raw.replace(/[_.]/g, "-")
  if (name.length > 64 || !KIND_NAME_RE.test(name)) return undefined
  return name
}

/** Map a qname to a kind name with table L1. Undefined means skip. */
export function mapQname(qname: string, ctx: ParseContext): string | undefined {
  const lower = qname.toLowerCase()
  if (lower.startsWith("ma::")) {
    if (qname.endsWith("::ROLE")) return undefined
    const hit = ctx.legacy.get(lower) ?? A2[lower]
    if (hit !== undefined) return hit
    const segs = lower.slice(4).split("::")
    if (segs.length === 1) return normalizeKind(segs[0] ?? "")
    const first = segs[0] ?? ""
    return normalizeKind(LEVELS.has(first) ? segs.slice(1).join("-") : segs.join("-"))
  }
  if (lower.startsWith("ma:")) return normalizeKind(lower.slice(3))
  const hit = ctx.legacy.get(lower)
  return hit ?? lower
}

/** The wire form of a qname: `v1` (`ma::`), `v2` (`ma:`) or `v1-bare`. */
export function formOf(qname: string): SidebandNode["form"] {
  if (qname.slice(0, 4).toLowerCase() === "ma::") return "v1"
  return qname.slice(0, 3).toLowerCase() === "ma:" ? "v2" : "v1-bare"
}

/** Attribute values of a start part, in source order. */
export type Attrs = Map<string, string>

/** Result of {@link readOpen}. */
export type OpenResult =
  | { status: "ok"; attrs: Attrs; end: number; empty: boolean }
  | { status: "none" }
  | { status: "incomplete" }

function skipWs(text: string, from: number): number {
  let i = from
  while (i < text.length && WS_RE.test(text.charAt(i))) i++
  return i
}

/** Read the attributes and the end of a start part, from the end of its qname. */
export function readOpen(
  text: string,
  from: number,
  form: SidebandNode["form"],
  bs: boolean,
): OpenResult {
  const attrs: Attrs = new Map()
  let j = from
  if (j >= text.length) return { status: "incomplete" }
  if (!WS_RE.test(text.charAt(j)) && text.charAt(j) !== ">" && text.charAt(j) !== "/")
    return { status: "none" }
  for (;;) {
    j = skipWs(text, j)
    if (j >= text.length) return { status: "incomplete" }
    const c = text.charAt(j)
    if (c === ">") return { status: "ok", attrs, end: j + 1, empty: false }
    if (c === "/") {
      if (j + 1 >= text.length) return { status: "incomplete" }
      return text.charAt(j + 1) === ">"
        ? { status: "ok", attrs, end: j + 2, empty: true }
        : { status: "none" }
    }
    ATTR_RE.lastIndex = j
    const nm = ATTR_RE.exec(text)
    if (!nm) return { status: "none" }
    j = skipWs(text, j + nm[0].length)
    if (j >= text.length) return { status: "incomplete" }
    if (text.charAt(j) !== "=") return { status: "none" }
    j = skipWs(text, j + 1)
    if (j >= text.length) return { status: "incomplete" }
    const q = text.charAt(j)
    if (q !== '"' && q !== "'") return { status: "none" }
    let k = j + 1
    for (;;) {
      if (k >= text.length) return { status: "incomplete" }
      const ch = text.charAt(k)
      if (ch === q) break
      if (ch === "<") return { status: "none" }
      k += ch === "\\" && bs ? 2 : 1
    }
    let value = text.slice(j + 1, k)
    if (bs) value = decodeBackslash(value)
    value = decodeRefs(value, form === "v2")
    if (!attrs.has(nm[0])) attrs.set(nm[0], value)
    j = k + 1
    if (j >= text.length) return { status: "incomplete" }
    const nx = text.charAt(j)
    if (!WS_RE.test(nx) && nx !== ">" && nx !== "/") return { status: "none" }
  }
}

type EndResult = { status: "found"; bodyEnd: number; end: number } | { status: "incomplete" }

function findEnd(
  text: string,
  from: number,
  kind: string,
  form: SidebandNode["form"],
  ctx: ParseContext,
): EndResult {
  let p = from
  for (;;) {
    const i = text.indexOf("<", p)
    if (i < 0) return { status: "incomplete" }
    if (form === "v2" && text.startsWith("<![CDATA[", i)) {
      const e = text.indexOf("]]>", i + 9)
      if (e < 0) return { status: "incomplete" }
      p = e + 3
      continue
    }
    if (text.charAt(i + 1) === "/") {
      const hit = matchQname(text, i + 2)
      if (hit) {
        const j = skipWs(text, hit.end)
        if (text.charAt(j) === ">" && mapQname(hit.text, ctx) === kind) {
          return { status: "found", bodyEnd: i, end: j + 1 }
        }
      }
    }
    p = i + 1
  }
}

function decodeBody(
  raw: string,
  form: SidebandNode["form"],
  decl: SidebandKind | undefined,
): string {
  let body = raw
  if (form === "v2") {
    let out = ""
    let last = 0
    CDATA_RE.lastIndex = 0
    for (let m = CDATA_RE.exec(raw); m; m = CDATA_RE.exec(raw)) {
      out += decodeRefs(raw.slice(last, m.index), true) + (m[1] ?? "")
      last = m.index + m[0].length
    }
    body = out + decodeRefs(raw.slice(last), true)
  } else if (decl?.legacyBodyEscaped) {
    body = decodeRefs(raw, false)
  }
  if (
    decl?.layout === "block" &&
    body.length >= 2 &&
    body.startsWith("\n") &&
    body.endsWith("\n")
  ) {
    body = body.slice(1, -1)
  }
  return body
}

/**
 * Try to read one node that starts at `pos` (the position of a `<`).
 * `accept` lets the scanner refuse a kind before it waits for a body.
 */
export function parseAt(
  text: string,
  pos: number,
  ctx: ParseContext,
  accept?: (kind: string) => boolean,
  noClose?: Set<string>,
): ParseAtResult {
  const hit = matchQname(text, pos + 1)
  if (!hit) {
    return isOpenerPrefix(text, pos + 1)
      ? { status: "incomplete", phase: "open" }
      : { status: "none" }
  }
  if (
    hit.end >= text.length ||
    (text.length - hit.end <= 2 && /^:{1,2}$/.test(text.slice(hit.end)))
  )
    return { status: "incomplete", phase: "open" }
  const kind = mapQname(hit.text, ctx)
  if (kind === undefined) return { status: "none" }
  if (accept && !accept(kind)) return { status: "none" }
  const form = formOf(hit.text)
  const decl = ctx.kind(kind)
  const bs = form === "v1" && decl?.direction === "from-model"
  const open = readOpen(text, hit.end, form, bs)
  if (open.status === "none") return { status: "none" }
  if (open.status === "incomplete") return { status: "incomplete", phase: "open" }
  const attrs: Record<string, string> = {}
  for (const [name, value] of open.attrs) {
    // v1 wire name to declared name (`chars_removed` -> `chars-removed`, design 3.1)
    const key = form === "v2" ? name : v1AttrDeclName(decl, name)
    if (!Object.hasOwn(attrs, key)) attrs[key] = value
  }
  const node: SidebandNode = {
    kind,
    attrs,
    selfClosing: open.empty,
    form,
    span: { start: pos, end: open.end },
    open: { start: pos, end: open.end },
  }
  if (form !== "v2") node.legacyQname = hit.text
  if (open.empty) return { status: "node", node, end: open.end }
  const key = `${kind}|${form}`
  if (noClose?.has(key)) return { status: "incomplete", phase: "body" }
  const close = findEnd(text, open.end, kind, form, ctx)
  if (close.status === "incomplete") {
    noClose?.add(key)
    return { status: "incomplete", phase: "body" }
  }
  node.body = decodeBody(text.slice(open.end, close.bodyEnd), form, decl)
  node.span = { start: pos, end: close.end }
  node.close = { start: close.bodyEnd, end: close.end }
  return { status: "node", node, end: close.end }
}

function shift(n: SidebandNode, by: number): SidebandNode {
  n.span = { start: n.span.start + by, end: n.span.end + by }
  if (n.open) n.open = { start: n.open.start + by, end: n.open.end + by }
  if (n.close) n.close = { start: n.close.start + by, end: n.close.end + by }
  return n
}

function parseTop(text: string, ctx: ParseContext, nested: boolean, out: SidebandNode[]): void {
  const noClose = new Set<string>()
  let pos = 0
  for (;;) {
    const i = text.indexOf("<", pos)
    if (i < 0) break
    const r = parseAt(text, i, ctx, undefined, noClose)
    if (r.status === "node") {
      out.push(r.node)
      const { open, close } = r.node
      if (nested && open && close && close.start > open.end) {
        const inner: SidebandNode[] = []
        parseTop(text.slice(open.end, close.start), ctx, true, inner)
        for (const n of inner) out.push(shift(n, open.end))
      }
      pos = r.end
    } else {
      pos = i + 1
    }
  }
}

/**
 * Parse text into nodes in text order. Never throws. Default: top-level
 * nodes only. `nested` also gives the nodes in a body (after their parent).
 * `legacyText` also gives the old bracket notices (form `v1-text`).
 * `kinds` keeps only the nodes of these kinds.
 */
export function parseText(
  text: string,
  ctx: ParseContext,
  opts: SidebandParseOptions = {},
): SidebandNode[] {
  let nodes: SidebandNode[] = []
  try {
    parseTop(text, ctx, opts.nested === true, nodes)
    if (opts.legacyText === true) {
      const legacy = readLegacyText(text).filter(
        (l) => !nodes.some((n) => l.span.start < n.span.end && n.span.start < l.span.end),
      )
      if (legacy.length > 0)
        nodes = [...nodes, ...legacy].sort((a, b) => a.span.start - b.span.start)
    }
  } catch {
    // never throws: give the nodes found so far
  }
  if (opts.kinds !== undefined) {
    const want = new Set(opts.kinds)
    return nodes.filter((n) => want.has(n.kind))
  }
  return nodes
}
