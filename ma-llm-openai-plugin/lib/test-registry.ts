// source: local test helper mirroring src/llm/model-registry read seam
/**
 * Minimal in-memory model/provider registry for the plugin's OWN unit tests.
 *
 * A repo-separated provider can't import the host registry (`src/llm/index`)
 * to read back `resolveModel` / `resolveProvider` in its tests. Instead the
 * test builds a local `ModelRegistrar` / `ProviderAdapterRegistrar`, drives
 * the provider's `registerXInto(registrar)` through it, and resolves the
 * captured entries here. This keeps the plugin's tests self-contained while
 * exercising the same registration path the host uses.
 *
 * @module lib/test-registry
 */

import type { ModelEntry, ProviderAdapter } from "./host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./provider-plugin.ts"

/** A tiny registrar + resolver pair for a single test run. */
export function makeTestRegistry(): {
  models: ModelRegistrar
  providers: { register(a: ProviderAdapter): void }
  resolveModel(id: string): ModelEntry
  resolveProvider(id: string): ProviderAdapter
} {
  const modelById = new Map<string, ModelEntry>()
  const aliasById = new Map<string, string>()
  const providerById = new Map<string, ProviderAdapter>()
  return {
    models: {
      register(spec: ProviderModelSpec): void {
        modelById.set(spec.id, spec as unknown as ModelEntry)
        for (const alias of spec.aliases ?? []) {
          if (alias !== spec.id) aliasById.set(alias, spec.id)
        }
      },
      setDefault(): void {},
    },
    providers: {
      register(adapter: ProviderAdapter): void {
        providerById.set(adapter.id, adapter)
      },
    },
    resolveModel(id: string): ModelEntry {
      const m = modelById.get(aliasById.get(id) ?? id)
      if (!m) throw new Error(`test registry: no model ${id}`)
      return m
    },
    resolveProvider(id: string): ProviderAdapter {
      const p = providerById.get(id)
      if (!p) throw new Error(`test registry: no provider ${id}`)
      return p
    },
  }
}
