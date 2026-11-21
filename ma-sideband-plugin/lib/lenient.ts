/**
 * Lenient read of tag parts (`stripLenient`, `leadingNode`).
 *
 * `parse` gives only COMPLETE nodes. Old session text and cut titles can
 * also hold a PART of a tag: a lone end part, a start part with no end part,
 * or a start part that the text cuts at its end. These functions read such
 * parts, so core holds no tag format (design step 8, section 2b).
 *
 * A part is `<` or `</`, a qname that the codec maps to a kind (v1, v2, bare
 * legacy), a name end (space, `/`, `>` or the end of the text), then the
 * text to the next `>`. A part with no `>` counts only when it runs to the
 * end of the text (a `<` before the `>` makes it plain text). The scan is
 * linear: each `<` reads forward only to the next `<` or `>`.
 *
 * @packageDocumentation
 */

import { v1AttrDeclName } from "./levels.ts"
import { formOf, mapQname, matchQname, type ParseContext, parseAt, readOpen } from "./parse.ts"
import type { SidebandNode, SidebandStripLenientOptions } from "./types.ts"

/** One tag part. */
interface Part {
  /** `open`: a start part. `close`: an end part. `self`: a self-closing part. */
  role: "open" | "close" | "self"
  /** The kind that the codec maps the qname to. */
  kind: string
  /** The qname as written. */
  qname: string
  /** Start offset (the `<`). */
  start: number
  /** End offset, exclusive. */
  end: number
  /** True when the part has no `>`: it runs to the end of the text. */
  cut: boolean
}

/** A range to replace. */
interface Cut {
  start: number
  end: number
  with: string
}

const NAME_END = /[ \t\r\n/>]/

/** The part that starts at `at` (a `<`), or `undefined`. */
function partAt(text: string, at: number, ctx: ParseContext): Part | undefined {
  const close = text.charAt(at + 1) === "/"
  const nameAt = at + (close ? 2 : 1)
  const hit = matchQname(text, nameAt)
  if (!hit) return undefined
  if (hit.end < text.length && !NAME_END.test(text.charAt(hit.end))) return undefined
  const kind = mapQname(hit.text, ctx)
  if (kind === undefined) return undefined
  let j = hit.end
  while (j < text.length) {
    const c = text.charAt(j)
    if (c === ">" || c === "<") break
    j++
  }
  if (text.charAt(j) === "<") return undefined
  const cut = j >= text.length
  const end = cut ? text.length : j + 1
  const rest = text.slice(hit.end, cut ? end : j)
  const role = close ? "close" : !cut && rest.trimEnd().endsWith("/") ? "self" : "open"
  return { role, kind, qname: hit.text, start: at, end, cut }
}

/** Each part of `text`, in text order, of the kinds in `want` (all when undefined). */
function partsOf(text: string, ctx: ParseContext, want: Set<string> | undefined): Part[] {
  const out: Part[] = []
  let pos = 0
  for (;;) {
    const i = text.indexOf("<", pos)
    if (i < 0) break
    const p = partAt(text, i, ctx)
    if (p && (want === undefined || want.has(p.kind))) {
      out.push(p)
      pos = p.end
    } else {
      pos = i + 1
    }
  }
  return out
}

/** Replace sorted, non-overlapping ranges of `text`. */
function splice(text: string, cuts: readonly Cut[]): string {
  if (cuts.length === 0) return text
  const out: string[] = []
  let pos = 0
  for (const c of cuts) {
    out.push(text.slice(pos, c.start), c.with)
    pos = c.end
  }
  out.push(text.slice(pos))
  return out.join("")
}

/**
 * Self-closing parts and complete blocks (the outermost one of a nest). A
 * start part pairs with the next end part of the same kind at its level; a
 * start part inside a pair goes with the pair.
 */
function blockCuts(parts: readonly Part[], r: string): Cut[] {
  const ranges: Cut[] = []
  const stack: Part[] = []
  const open = new Map<string, number>()
  for (const p of parts) {
    if (p.role === "self") {
      ranges.push({ start: p.start, end: p.end, with: r })
    } else if (p.role === "open") {
      if (p.cut) continue
      stack.push(p)
      open.set(p.kind, (open.get(p.kind) ?? 0) + 1)
    } else if ((open.get(p.kind) ?? 0) > 0) {
      // Pop to the start part of the same kind. Each part is popped one time.
      for (;;) {
        const top = stack.pop() as Part
        open.set(top.kind, (open.get(top.kind) ?? 1) - 1)
        if (top.kind === p.kind) {
          ranges.push({ start: top.start, end: p.end, with: r })
          break
        }
      }
    }
  }
  // Keep the outermost ranges: sort by start (end descending), drop each
  // range inside an earlier one.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Cut[] = []
  let maxEnd = -1
  for (const c of ranges) {
    if (c.start < maxEnd) continue
    out.push(c)
    maxEnd = c.end
  }
  return out
}

/**
 * A start part with no end part, and a line feed after it: the part and the
 * rest of its line become one line feed.
 */
function lineCuts(text: string, parts: readonly Part[]): Cut[] {
  const out: Cut[] = []
  let after = 0
  for (const p of parts) {
    if (p.role !== "open" || p.cut || p.start < after) continue
    const nl = text.indexOf("\n", p.end)
    if (nl < 0) break
    out.push({ start: p.start, end: nl + 1, with: "\n" })
    after = nl + 1
  }
  return out
}

/** Each part becomes `r`. */
function partCuts(parts: readonly Part[], r: string): Cut[] {
  return parts.map((p) => ({ start: p.start, end: p.end, with: r }))
}

/**
 * Remove the sideband tags of `text`, also the broken ones.
 *
 * Default (`keepBody` false), in this order: each self-closing part and
 * each complete block with its body (a nest goes as one range); then each
 * start part with no end part and a line feed after it, with the rest of
 * its line (it becomes a line feed); then each other part (a lone end part,
 * a lone start part, a start part that the text cuts at its end).
 *
 * With `keepBody` true: each part (start, end, self-closing, cut) goes, and
 * the text between the parts stays.
 *
 * Linear time. Text with no part does not change.
 */
export function stripLenient(
  text: string,
  ctx: ParseContext,
  opts: SidebandStripLenientOptions = {},
): string {
  if (text.indexOf("<") < 0) return text
  const want = opts.kinds === undefined ? undefined : new Set(opts.kinds)
  const r = opts.replacement ?? ""
  if (opts.keepBody === true) return splice(text, partCuts(partsOf(text, ctx, want), r))
  let out = splice(text, blockCuts(partsOf(text, ctx, want), r))
  out = splice(out, lineCuts(out, partsOf(out, ctx, want)))
  return splice(out, partCuts(partsOf(out, ctx, want), r))
}

/**
 * A start part that only its name proves (a `<` comes before its `>`): the
 * span ends at the name end. For {@link leadingNode} only.
 */
function namePart(text: string, at: number, ctx: ParseContext): Part | undefined {
  if (text.charAt(at + 1) === "/") return undefined
  const hit = matchQname(text, at + 1)
  if (!hit || (hit.end < text.length && !NAME_END.test(text.charAt(hit.end)))) return undefined
  const kind = mapQname(hit.text, ctx)
  if (kind === undefined) return undefined
  return { role: "open", kind, qname: hit.text, start: at, end: hit.end, cut: true }
}

/** True for a space, tab, carriage return or line feed. */
const isSpace = (ch: string): boolean => ch === " " || ch === "\n" || ch === "\t" || ch === "\r"

/**
 * The node that starts at the first non-space character of `text`, else
 * `undefined`. A complete node comes from `parse`. A start part with no end
 * part (also one that the text cuts at its end, or one with a `<` before
 * its `>`) gives a node of its start part only: no body. An end part gives
 * `undefined`. The name decides, as the old name probe did.
 */
export function leadingNode(text: string, ctx: ParseContext): SidebandNode | undefined {
  let i = 0
  while (i < text.length && isSpace(text.charAt(i))) i++
  if (text.charAt(i) !== "<") return undefined
  const r = parseAt(text, i, ctx)
  if (r.status === "node") return r.node
  const p = partAt(text, i, ctx) ?? namePart(text, i, ctx)
  if (p === undefined || p.role === "close") return undefined
  const form = formOf(p.qname)
  const attrs: Record<string, string> = {}
  const head = readOpen(text, i + 1 + p.qname.length, form, false)
  if (head.status === "ok") {
    const decl = ctx.kind(p.kind)
    for (const [name, value] of head.attrs) {
      const key = form === "v2" ? name : v1AttrDeclName(decl, name)
      if (!Object.hasOwn(attrs, key)) attrs[key] = value
    }
  }
  const node: SidebandNode = {
    kind: p.kind,
    attrs,
    selfClosing: p.role === "self",
    form,
    span: { start: p.start, end: p.end },
    open: { start: p.start, end: p.end },
  }
  if (form !== "v2") node.legacyQname = p.qname
  return node
}
