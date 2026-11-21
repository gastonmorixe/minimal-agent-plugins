/**
 * Each huggingface model entry has the token estimator of the upstream tokenizer
 * family (from `ma-token-estimate-kit`), with `generic` for an unknown id.
 */

import { describe, expect, it } from "bun:test"

import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import { registerHuggingFaceModelInto, registerHuggingFaceModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("huggingface token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerHuggingFaceModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("deepseek-ai/DeepSeek-V4-Pro")?.estimateTokens).toBe(
      estimatorForFamily("deepseek"),
    )
    expect(specs.get("zai-org/GLM-5.3")?.estimateTokens).toBe(estimatorForFamily("glm"))
    expect(specs.get("openai/gpt-oss-120b")?.estimateTokens).toBe(
      estimatorForFamily("openai-o200k"),
    )
    expect(specs.get("MiniMaxAI/MiniMax-M3")?.estimateTokens).toBe(estimatorForFamily("minimax"))
  })

  it("gives an ad-hoc model the family of its id, else generic", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerHuggingFaceModelInto(registrar(specs) as never, { id: "Qwen/Qwen4-Coder" })
    registerHuggingFaceModelInto(registrar(specs) as never, { id: "nvidia/Nemotron-X" })
    expect(specs.get("Qwen/Qwen4-Coder")?.estimateTokens).toBe(estimatorForFamily("qwen"))
    expect(specs.get("nvidia/Nemotron-X")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
