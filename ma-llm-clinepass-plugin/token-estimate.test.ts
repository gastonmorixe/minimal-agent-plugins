/**
 * Each clinepass model entry has the token estimator of the upstream tokenizer
 * family (from `ma-token-estimate-kit`), with `generic` for an unknown id.
 */

import { describe, expect, it } from "bun:test"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { registerClinepassModel, registerClinepassModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("clinepass token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerClinepassModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("cline-pass/kimi-k3")?.estimateTokens).toBe(estimatorForFamily("kimi"))
    expect(specs.get("cline-pass/deepseek-v4-pro")?.estimateTokens).toBe(
      estimatorForFamily("deepseek"),
    )
    expect(specs.get("cline-pass/qwen3.7-max")?.estimateTokens).toBe(estimatorForFamily("qwen"))
    expect(specs.get("cline-pass/mimo-v2.5")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })

  it("gives an ad-hoc model the family of its id, else generic", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerClinepassModel({ id: "cline-pass/glm-6" }, registrar(specs) as never)
    registerClinepassModel({ id: "cline-pass/mimo-v3" }, registrar(specs) as never)
    expect(specs.get("cline-pass/glm-6")?.estimateTokens).toBe(estimatorForFamily("glm"))
    expect(specs.get("cline-pass/mimo-v3")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
