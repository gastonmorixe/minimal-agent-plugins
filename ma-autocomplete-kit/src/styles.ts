/**
 * Buffer style spans.
 *
 * Paint every sigil token in the editor buffer whose query matches at least
 * one menu item, so the user can see what will expand. Emit via
 * `editor.buffer.styles` with a per-plugin `source` id so producers compose
 * instead of stomping each other.
 *
 * @module ma-autocomplete-kit/styles
 */

import { sigilTokenSgr } from "./palette.ts"
import { filterByCategories, scoreItems } from "./scoring.ts"
import type { Item, TriggerSpec } from "./types.ts"

export interface BufferStyleSpan {
  start: number
  end: number
  style: string
}

/**
 * Style sigil tokens whose partial or final query matches a menu item.
 *
 * `spanRe` MUST be global and carry two groups: (1) boundary prefix,
 * (2) the query after the sigil.
 */
export function sigilStyleSpans(
  text: string,
  items: readonly Item[],
  spec: TriggerSpec,
  sgr: string = sigilTokenSgr(),
): BufferStyleSpan[] {
  if (!text || items.length === 0) return []

  const pool = filterByCategories(items, spec.categories)
  const spans: BufferStyleSpan[] = []
  const re = new RegExp(spec.spanRe.source, "g")
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const prefix = match[1] ?? ""
    const query = match[2] ?? ""
    const start = match.index + prefix.length
    if (scoreItems([...pool], query).length > 0) {
      spans.push({ start, end: start + 1 + query.length, style: sgr })
    }
  }
  return spans
}
