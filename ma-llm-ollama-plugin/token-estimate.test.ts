/**
 * Each ollama model entry has the token estimator of the upstream tokenizer
 * family (from `ma-token-estimate-kit`), with `generic` for an unknown id.
 */

import { describe, expect, it } from "bun:test"

import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import { registerOllamaAdHocModelInto, registerOllamaModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("ollama token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOllamaModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("deepseek-v4-pro:0813")?.estimateTokens).toBe(estimatorForFamily("deepseek"))
    expect(specs.get("glm-5.3")?.estimateTokens).toBe(estimatorForFamily("glm"))
    expect(specs.get("kimi-k3")?.estimateTokens).toBe(estimatorForFamily("kimi"))
    expect(specs.get("mimo-v2.6-pro")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })

  it("gives an ad-hoc model the family of its id, else generic", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOllamaAdHocModelInto(registrar(specs) as never, "qwen4:235b")
    registerOllamaAdHocModelInto(registrar(specs) as never, "nemotron-4:70b")
    expect(specs.get("qwen4:235b")?.estimateTokens).toBe(estimatorForFamily("qwen"))
    expect(specs.get("nemotron-4:70b")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
