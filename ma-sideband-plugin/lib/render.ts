import { escapeModeFor, escapeV1Attr } from "./escape.ts"
import { v1Qname } from "./levels.ts"
import type { SidebandKind, SidebandMessage } from "./types.ts"

/**
 * Render a message as the current v1 wire form.
 * Self closing: `<qname a="b" />`. Paired: LF inside the tags when layout is block.
 * Attributes follow the key order of `kind.attrs`. Absent attributes (undefined, null, empty string) are omitted.
 * Bodies are raw. Caller newlines are not part of the result.
 */
export function renderV1(kind: SidebandKind, msg: SidebandMessage): string {
  const qname = v1Qname(kind)
  const mode = escapeModeFor(kind.kind)
  let open = qname
  for (const key of Object.keys(kind.attrs)) {
    const value = msg.attrs?.[key]
    if (value === undefined || value === null || value === "") continue
    open += ` ${key}="${escapeV1Attr(String(value), mode)}"`
  }
  if (msg.body === undefined) return `<${open} />`
  const body = msg.body
  const nl = kind.layout === "block" ? "\n" : ""
  return `<${open}>${nl}${body}${nl}</${qname}>`
}
