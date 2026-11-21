/**
 * Each Meta model entry has the `meta-muse` token estimator (from
 * `ma-token-estimate-kit`).
 */

import { describe, expect, it } from "bun:test"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { registerMetaModel, registerMetaModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("meta token estimators", () => {
  it("gives the meta-muse estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerMetaModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    const muse = estimatorForFamily("meta-muse")
    for (const spec of specs.values()) expect(spec.estimateTokens).toBe(muse)
    for (const id of ["muse-spark-1.3", "muse-wonder-1.0-chat", "muse-ember-1.0"]) {
      expect(specs.get(id)?.estimateTokens).toBe(muse)
    }
  })

  it("gives the meta-muse estimator to an ad-hoc model", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerMetaModel({ id: "muse-nova-2.0" }, registrar(specs) as never)
    expect(specs.get("muse-nova-2.0")?.estimateTokens).toBe(estimatorForFamily("meta-muse"))
  })
})
