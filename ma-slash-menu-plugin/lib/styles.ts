import { scoreItems } from "./scoring.ts"
import { slashTokenSgr } from "./palette.ts"
import type { Item } from "./types.ts"

export interface BufferStyleSpan {
  start: number
  end: number
  style: string
}

const TOKEN_RE = /(^|[\s([{])([/$])([A-Za-z0-9_-]*)/g

/** Style slash tokens whose partial or final query matches a menu item.
 * Emit via `editor.buffer.styles` with `source: "slash-menu"` so intercom
 * (and other producers) can compose without last-writer-wins stomping.
 */
export function slashStyleSpans(
  text: string,
  items: readonly Item[],
  sgr: string = slashTokenSgr(),
): BufferStyleSpan[] {
  if (!text || items.length === 0) return []

  const spans: BufferStyleSpan[] = []
  const re = new RegExp(TOKEN_RE.source, "g")
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const prefix = match[1] ?? ""
    const trigger = match[2] as "/" | "$"
    const query = match[3] ?? ""
    const start = match.index + prefix.length
    const candidates = trigger === "$" ? items.filter((item) => item.category === "skl") : items
    if (scoreItems([...candidates], query).length > 0) {
      spans.push({ start, end: start + 1 + query.length, style: sgr })
    }
  }
  return spans
}
