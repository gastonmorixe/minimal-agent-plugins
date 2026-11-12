/**
 * Prompt provider: turns the on-disk library into autocomplete kit items.
 *
 * One item per prompt. Broken files become `disabled` rows so one bad file
 * never breaks the menu. The payload carries the body so Alt+Enter can insert
 * it without a second disk read.
 *
 * @module lib/provider
 */

import type { Item, Provider } from "../../ma-autocomplete-kit/src/index.ts"

import type { LoadResult, StoreDeps } from "./store.ts"
import { loadPrompts } from "./store.ts"

/** Flatten a description to one line and clip it for the menu row. */
function flatten(desc: string, maxChars = 200): string {
  const flat = desc.replace(/\s+/g, " ").trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`
}

/** Build kit items from a load result. */
export function itemsFromLoad(result: LoadResult): Item[] {
  const items: Item[] = []
  for (const p of result.prompts) {
    items.push({
      slug: p.slug,
      description: flatten(p.description) || "(no description)",
      category: "prm",
      payload: { body: p.body, scope: p.scope, path: p.path },
    })
  }
  for (const b of result.broken) {
    items.push({
      slug: b.slug,
      description: b.errors[0] ?? "broken file",
      category: "prm",
      disabled: true,
      disabledReason: b.errors[0] ?? "broken file",
    })
  }
  items.sort((a, b) => a.slug.localeCompare(b.slug))
  return items
}

/** A provider bound to the given store deps. */
export function makePromptsProvider(deps: StoreDeps): Provider {
  return {
    id: "prompts",
    list: () => itemsFromLoad(loadPrompts(deps)),
  }
}
