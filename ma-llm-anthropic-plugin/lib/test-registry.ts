// source: local test helper mirroring the host model/provider registry read seam
/**
 * Minimal in-memory model/provider registry for the plugin's OWN unit tests.
 *
 * A repo-separated provider can't import the host registry (`src/llm/*`) to read
 * back `resolveModel` / `resolveProvider`. Instead a test builds a local
 * `ProviderSetupContext`, drives `bootstrapAnthropic(ctx)` through it, and
 * resolves the captured entries here. Because `registerAnthropicModels` ALSO
 * mirrors every spec into the plugin-local catalog (`lib/registry.ts`), the
 * plugin's own `findModel` sees the same entries — so both the test's resolver
 * and the production code paths resolve consistently after `setupAnthropic()`.
 *
 * @module lib/test-registry
 */

import type { ModelEntry, ProviderAdapter } from "./host-types.ts"
import type { ProviderModelSpec, ProviderSetupContext } from "./provider-plugin.ts"
import { clearLocalCatalog } from "./registry.ts"

/** A local setup context + resolver pair for a single test run. */
export interface TestRegistry {
  ctx: ProviderSetupContext
  resolveModel(id: string): ModelEntry
  resolveProvider(id: string): ProviderAdapter
  findProvider(id: string): ProviderAdapter | undefined
}

/** Build a fresh test registry and reset the plugin-local catalog. */
export function makeTestRegistry(): TestRegistry {
  clearLocalCatalog()
  const modelById = new Map<string, ModelEntry>()
  const aliasToId = new Map<string, string>()
  const providerById = new Map<string, ProviderAdapter>()
  const ctx: ProviderSetupContext = {
    models: {
      register(spec: ProviderModelSpec): void {
        modelById.set(spec.id, spec as unknown as ModelEntry)
        for (const a of spec.aliases ?? []) {
          if (a !== spec.id) aliasToId.set(a, spec.id)
        }
      },
      setDefault(): void {},
    },
    providers: {
      register(adapter): void {
        providerById.set(adapter.id, adapter as unknown as ProviderAdapter)
      },
    },
  }
  const resolveModel = (id: string): ModelEntry => {
    const direct =
      modelById.get(id) ?? (aliasToId.has(id) ? modelById.get(aliasToId.get(id)!) : undefined)
    if (!direct) throw new Error(`test registry: no model ${id}`)
    return direct
  }
  return {
    ctx,
    resolveModel,
    resolveProvider(id: string): ProviderAdapter {
      const p = providerById.get(id)
      if (!p) throw new Error(`test registry: no provider ${id}`)
      return p
    },
    findProvider: (id: string) => providerById.get(id),
  }
}
