/**
 * Each Grok model entry has the `grok` token estimator (from
 * `ma-token-estimate-kit`).
 */

import { describe, expect, it } from "bun:test"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { registerGrokModel, registerGrokModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("grok token estimators", () => {
  it("gives the grok estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerGrokModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    const grok = estimatorForFamily("grok")
    for (const spec of specs.values()) expect(spec.estimateTokens).toBe(grok)
    for (const id of ["grok-4.7", "grok-build-chat", "grok-4.20-reasoning"]) {
      expect(specs.get(id)?.estimateTokens).toBe(grok)
    }
  })

  it("gives the grok estimator to an ad-hoc model", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerGrokModel({ id: "grok-9-preview" }, registrar(specs) as never)
    expect(specs.get("grok-9-preview")?.estimateTokens).toBe(estimatorForFamily("grok"))
  })
})
