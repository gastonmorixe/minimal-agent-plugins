import { bodyModeFor, escapeModeFor, escapeV1Attr, escapeV1Body } from "./escape.ts"
import { v1AttrWireName, v1Qname } from "./levels.ts"
import type { SidebandKind, SidebandMessage } from "./types.ts"

/** The inner text of a v1 start part: the qname and the attributes, no `<` or `>`. */
function openInner(kind: SidebandKind, msg: SidebandMessage): string {
  const mode = escapeModeFor(kind.kind)
  let open = v1Qname(kind)
  for (const key of Object.keys(kind.attrs)) {
    const value = msg.attrs?.[key]
    if (value === undefined || value === null || value === "") continue
    open += ` ${v1AttrWireName(kind.kind, key)}="${escapeV1Attr(String(value), mode)}"`
  }
  return open
}

/**
 * Render only the v1 start part: `<qname a="b">`. Attribute rules are the
 * rules of `renderV1`. The body of `msg` is ignored. No LF: for a block
 * layout, `renderV1` puts the LF between the parts.
 */
export function renderV1Open(kind: SidebandKind, msg: SidebandMessage): string {
  return `<${openInner(kind, msg)}>`
}

/** Render only the v1 end part: `</qname>`. */
export function renderV1Close(kind: SidebandKind): string {
  return `</${v1Qname(kind)}>`
}

/**
 * Render a message as the current v1 wire form.
 * Self closing: `<qname a="b" />`. Paired: LF inside the tags when layout is block.
 * Attributes follow the key order of `kind.attrs`. Absent attributes (undefined, null, empty string) are omitted.
 * The escape row of the kind (escape.ts) sets the attribute and body escape.
 * The v1 wire name of an attribute can differ from the declared name (levels.ts).
 * Caller newlines are not part of the result.
 */
export function renderV1(kind: SidebandKind, msg: SidebandMessage): string {
  if (msg.body === undefined) return `<${openInner(kind, msg)} />`
  const body = escapeV1Body(msg.body, bodyModeFor(kind.kind))
  const nl = kind.layout === "block" ? "\n" : ""
  return `${renderV1Open(kind, msg)}${nl}${body}${nl}${renderV1Close(kind)}`
}
