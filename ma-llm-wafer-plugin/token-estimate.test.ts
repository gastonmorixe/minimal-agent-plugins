/**
 * Each wafer model entry has the token estimator of the upstream tokenizer
 * family (from `ma-token-estimate-kit`), with `generic` for an unknown id.
 */

import { describe, expect, it } from "bun:test"

import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import { registerWaferModel, registerWaferModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("wafer token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerWaferModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("GLM-5.3")?.estimateTokens).toBe(estimatorForFamily("glm"))
    expect(specs.get("Kimi-K3.1-Pro")?.estimateTokens).toBe(estimatorForFamily("kimi"))
    expect(specs.get("DeepSeek-V4-Pro")?.estimateTokens).toBe(estimatorForFamily("deepseek"))
    expect(specs.get("MiniMax-M3.1-Flash")?.estimateTokens).toBe(estimatorForFamily("minimax"))
  })

  it("gives an ad-hoc model the family of its id, else generic", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerWaferModel({ id: "Qwen4-Max" }, registrar(specs) as never)
    registerWaferModel({ id: "Mystery-1" }, registrar(specs) as never)
    expect(specs.get("Qwen4-Max")?.estimateTokens).toBe(estimatorForFamily("qwen"))
    expect(specs.get("Mystery-1")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
