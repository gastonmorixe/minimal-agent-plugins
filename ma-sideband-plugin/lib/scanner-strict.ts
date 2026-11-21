/**
 * The `strictV1` grammar of the scanner: the grammar of the old core
 * TagScanner (core `src/plugins/scanner.ts`), byte for byte. The core stream
 * uses it, so the switch to the codec changes no stream event.
 *
 * - Opener: exactly `<ma::emit::NAME` (case-sensitive), NAME of
 *   `[A-Za-z0-9_-]`. The kind is NAME as written (no registry lookup).
 * - Attributes: `KEY="v"` or `KEY='v'`, no space around `=`, no space needed
 *   between two attributes. A value can hold `<`. Escapes `\n \t \\ \" \'`;
 *   any other `\c` gives `c`. No entity decode. The last duplicate wins.
 * - End part: exactly `</ma::emit::NAME>`, the first one after the opener.
 *   The body is the raw text between the parts.
 */
import type { ParseAtResult } from "./parse.ts"
import type { SidebandNode } from "./types.ts"

const OPENER = "<ma::emit::"
const NAME_RE = /[A-Za-z0-9_-]/
const isName = (c: string): boolean => c.length === 1 && NAME_RE.test(c)
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r"

type Open =
  | { status: "ok"; name: string; attrs: Record<string, string>; empty: boolean; end: number }
  | { status: "none" }
  | { status: "incomplete" }

function readStrictOpen(s: string, at: number): Open {
  const rest = s.length - at
  if (rest < OPENER.length) {
    return OPENER.startsWith(s.slice(at)) ? { status: "incomplete" } : { status: "none" }
  }
  if (!s.startsWith(OPENER, at)) return { status: "none" }
  let i = at + OPENER.length
  const nameStart = i
  while (i < s.length && isName(s.charAt(i))) i++
  if (i === nameStart) return i >= s.length ? { status: "incomplete" } : { status: "none" }
  const name = s.slice(nameStart, i)
  const attrs: Record<string, string> = {}
  for (;;) {
    while (i < s.length && isSpace(s.charAt(i))) i++
    if (i >= s.length) return { status: "incomplete" }
    const c = s.charAt(i)
    if (c === ">") return { status: "ok", name, attrs, empty: false, end: i + 1 }
    if (c === "/") {
      if (i + 1 >= s.length) return { status: "incomplete" }
      if (s.charAt(i + 1) !== ">") return { status: "none" }
      return { status: "ok", name, attrs, empty: true, end: i + 2 }
    }
    const keyStart = i
    while (i < s.length && isName(s.charAt(i))) i++
    if (i === keyStart) return { status: "none" }
    if (i >= s.length) return { status: "incomplete" }
    const key = s.slice(keyStart, i)
    if (s.charAt(i) !== "=") return { status: "none" }
    i++
    if (i >= s.length) return { status: "incomplete" }
    const quote = s.charAt(i)
    if (quote !== '"' && quote !== "'") return { status: "none" }
    i++
    let value = ""
    let closed = false
    while (i < s.length) {
      const ch = s.charAt(i)
      if (ch === "\\") {
        if (i + 1 >= s.length) return { status: "incomplete" }
        const next = s.charAt(i + 1)
        value += next === "n" ? "\n" : next === "t" ? "\t" : next
        i += 2
        continue
      }
      if (ch === quote) {
        i++
        closed = true
        break
      }
      value += ch
      i++
    }
    if (!closed) return { status: "incomplete" }
    attrs[key] = value
  }
}

/**
 * Try to read one strict node at `pos` (a `<`). `accept` gets the name as
 * written. Result shape is the same as `parseAt`.
 */
export function parseStrictAt(
  text: string,
  pos: number,
  accept: (name: string) => boolean,
): ParseAtResult {
  const open = readStrictOpen(text, pos)
  if (open.status !== "ok") {
    return open.status === "incomplete" ? { status: "incomplete", phase: "open" } : open
  }
  if (!accept(open.name)) return { status: "none" }
  const qname = `ma::emit::${open.name}`
  const node: SidebandNode = {
    kind: open.name,
    attrs: open.attrs,
    selfClosing: open.empty,
    form: "v1",
    legacyQname: qname,
    span: { start: pos, end: open.end },
    open: { start: pos, end: open.end },
  }
  if (open.empty) return { status: "node", node, end: open.end }
  const close = `</${qname}>`
  const at = text.indexOf(close, open.end)
  if (at < 0) return { status: "incomplete", phase: "body" }
  const end = at + close.length
  node.body = text.slice(open.end, at)
  node.span = { start: pos, end }
  node.close = { start: at, end }
  return { status: "node", node, end }
}
