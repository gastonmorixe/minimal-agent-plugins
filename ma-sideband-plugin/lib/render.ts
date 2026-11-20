import { bodyModeFor, escapeModeFor, escapeV1Attr, escapeV1Body } from "./escape.ts"
import { v1AttrWireName, v1Qname } from "./levels.ts"
import type { SidebandKind, SidebandMessage } from "./types.ts"

/**
 * Render a message as the current v1 wire form.
 * Self closing: `<qname a="b" />`. Paired: LF inside the tags when layout is block.
 * Attributes follow the key order of `kind.attrs`. Absent attributes (undefined, null, empty string) are omitted.
 * The escape row of the kind (escape.ts) sets the attribute and body escape.
 * The v1 wire name of an attribute can differ from the declared name (levels.ts).
 * Caller newlines are not part of the result.
 */
export function renderV1(kind: SidebandKind, msg: SidebandMessage): string {
  const qname = v1Qname(kind)
  const mode = escapeModeFor(kind.kind)
  let open = qname
  for (const key of Object.keys(kind.attrs)) {
    const value = msg.attrs?.[key]
    if (value === undefined || value === null || value === "") continue
    open += ` ${v1AttrWireName(kind.kind, key)}="${escapeV1Attr(String(value), mode)}"`
  }
  if (msg.body === undefined) return `<${open} />`
  const body = escapeV1Body(msg.body, bodyModeFor(kind.kind))
  const nl = kind.layout === "block" ? "\n" : ""
  return `<${open}>${nl}${body}${nl}</${qname}>`
}
