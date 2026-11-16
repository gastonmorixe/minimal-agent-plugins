/**
 * Static adapter registry. This is the ONLY file in the engine that imports
 * adapter modules. Adapters never import each other.
 *
 * Native is pinned first. Other adapters follow in `adapterOrder`, each
 * gated by `adapters.<id>` in the plugin config (default on).
 *
 * @module engine/registry
 */

import { claudeAdapter } from "../adapters/claude/adapter.ts"
import { nativeAdapter } from "../native/adapter.ts"

import type { HooksConfig } from "./config.ts"
import type { HookDialectAdapter } from "./types.ts"

/** Every dialect adapter that ships with the plugin, except native. */
export const DIALECT_ADAPTERS: readonly HookDialectAdapter[] = [
  claudeAdapter,
  // A future Codex adapter is added the same way.
]

/** Pick the adapters for a config: native first, then enabled ones in order. */
export function selectAdapters(
  config: HooksConfig,
  available: readonly HookDialectAdapter[] = DIALECT_ADAPTERS,
): HookDialectAdapter[] {
  const byId = new Map(available.map((a) => [a.id, a]))
  const order = [...config.adapterOrder]
  for (const a of available) if (!order.includes(a.id)) order.push(a.id)
  const out: HookDialectAdapter[] = [nativeAdapter]
  for (const id of order) {
    const a = byId.get(id)
    if (!a || config.adapters[id] === false) continue
    if (!out.includes(a)) out.push(a)
  }
  return out
}
