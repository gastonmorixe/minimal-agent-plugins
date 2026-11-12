import { decodeBackslash, decodeRefs } from "./refs.ts"
import type { ReadonlySidebandRegistry, SidebandKind, SidebandNode } from "./types.ts"

const SEG = "[A-Za-z0-9_][A-Za-z0-9_.-]*"
const MA_RE = new RegExp(`ma(?::${SEG}|(?:::${SEG})+)`, "iy")
const BARE_RE = /(?:mode-change|memory-saved|short-term-memory|tui-preview)(?![A-Za-z0-9_.-])/iy
const ATTR_RE = new RegExp(SEG, "y")
const WS_RE = /[ \t\r\n]/
const BARE_NAMES = ["mode-change", "memory-saved", "short-term-memory", "tui-preview"]
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

function matchQname(text: string, at: number): QnameHit | undefined {
  MA_RE.lastIndex = at
  const m = MA_RE.exec(text)
  if (m) return { text: m[0], end: at + m[0].length }
  BARE_RE.lastIndex = at
  const b = BARE_RE.exec(text)
  if (b) return { text: b[0], end: at + b[0].length }
  return undefined
}

function isOpenerPrefix(rest: string): boolean {
  const low = rest.toLowerCase()
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

function formOf(qname: string): SidebandNode["form"] {
  if (qname.slice(0, 4).toLowerCase() === "ma::") return "v1"
  return qname.slice(0, 3).toLowerCase() === "ma:" ? "v2" : "v1-bare"
}

type Attrs = Map<string, string>

type OpenResult =
  | { status: "ok"; attrs: Attrs; end: number; empty: boolean }
  | { status: "none" }
  | { status: "incomplete" }

function skipWs(text: string, from: number): number {
  let i = from
  while (i < text.length && WS_RE.test(text.charAt(i))) i++
  return i
}

function readOpen(text: string, from: number, form: SidebandNode["form"], bs: boolean): OpenResult {
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
    return isOpenerPrefix(text.slice(pos + 1))
      ? { status: "incomplete", phase: "open" }
      : { status: "none" }
  }
  if (hit.end >= text.length || /^:{1,2}$/.test(text.slice(hit.end)))
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
  const attrs = Object.fromEntries(open.attrs)
  const node: SidebandNode = {
    kind,
    attrs,
    selfClosing: open.empty,
    form,
    span: { start: pos, end: open.end },
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
  return { status: "node", node, end: close.end }
}

/** Parse text into top-level nodes in text order. Never throws. */
export function parseText(text: string, ctx: ParseContext): SidebandNode[] {
  const nodes: SidebandNode[] = []
  const noClose = new Set<string>()
  try {
    let pos = 0
    for (;;) {
      const i = text.indexOf("<", pos)
      if (i < 0) break
      const r = parseAt(text, i, ctx, undefined, noClose)
      if (r.status === "node") {
        nodes.push(r.node)
        pos = r.end
      } else {
        pos = i + 1
      }
    }
  } catch {
    return nodes
  }
  return nodes
}
