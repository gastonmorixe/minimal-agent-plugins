/**
 * Plugin-local model catalog.
 *
 * A repo-separated provider plugin can't read the host model registry
 * (`src/llm/model-registry.ts`). It doesn't need to: it KNOWS its own catalog
 * because it just registered it. This module keeps the plugin's own copy of the
 * `ModelEntry` records it contributes (through `ctx.models` at activation) so the
 * plugin's auxiliary paths — header building for the quota probe / model-list GET,
 * context-window lookup for the footer, beta-flag gating — can resolve a model by
 * id/alias/tag without a host `src/` import. Mirrors the openai plugin's
 * `localCatalog`, but stores full entries because the Anthropic header/probe
 * builders read `capabilities`, not just id+tags.
 *
 * This is NOT a second source of truth for the host: the host registry is
 * populated in parallel via `ctx.models.register`; this local copy is read-only
 * aux state the plugin owns.
 *
 * @module lib/registry
 */

import type { ModelEntry } from "./host-types.ts"

const models = new Map<string, ModelEntry>()
const aliases = new Map<string, string>()

/** Record a model entry into the plugin-local catalog (last-write-wins). */
export function recordModel(entry: ModelEntry): void {
  models.set(entry.id, entry)
  if (entry.aliases) {
    for (const a of entry.aliases) {
      if (a !== entry.id) aliases.set(a, entry.id)
    }
  }
}

/** Reset the local catalog (called at the top of each register run + tests). */
export function clearLocalCatalog(): void {
  models.clear()
  aliases.clear()
}

/** Look up a model by id or alias; `undefined` when not registered. */
export function findModel(idOrAlias: string): ModelEntry | undefined {
  const direct = models.get(idOrAlias)
  if (direct) return direct
  const aliased = aliases.get(idOrAlias)
  return aliased ? models.get(aliased) : undefined
}

/** Look up a model by id or alias; throws when not registered. */
export function resolveModel(idOrAlias: string): ModelEntry {
  const entry = findModel(idOrAlias)
  if (!entry) {
    throw new Error(
      `unknown model "${idOrAlias}". Registered: ${[...models.keys()].sort().join(", ")}`,
    )
  }
  return entry
}

/** First registered model whose `tags` include EVERY tag in `mustHave`. */
export function findModelByTags(mustHave: readonly string[]): ModelEntry | undefined {
  for (const m of models.values()) {
    const tags = m.tags ?? []
    if (mustHave.every((t) => tags.includes(t))) return m
  }
  return undefined
}

/** Every registered entry, in insertion order. */
export function listLocalModels(): ModelEntry[] {
  return [...models.values()]
}
