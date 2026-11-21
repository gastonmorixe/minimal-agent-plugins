/**
 * Each OpenAI model entry has the token estimator of its tokenizer family
 * (from `ma-token-estimate-kit`).
 */

import { describe, expect, it } from "bun:test"

import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import { estimatorForOpenAIModel, registerOpenAIModels } from "./models.ts"

function registerAll(): Map<string, ProviderModelSpec> {
  const specs = new Map<string, ProviderModelSpec>()
  registerOpenAIModels({ register: (spec) => specs.set(spec.id, spec), setDefault: () => {} })
  return specs
}

describe("openai token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = registerAll()
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
  })

  it("uses openai-o200k for the catalog models", () => {
    const specs = registerAll()
    const o200k = estimatorForFamily("openai-o200k")
    for (const id of ["gpt-6.2-astra", "gpt-4o", "gpt-4.1", "o3", "chat-latest"]) {
      expect(specs.get(id)?.estimateTokens).toBe(o200k)
    }
  })

  it("uses openai-cl100k for plain gpt-4 and gpt-3.5 ids", () => {
    const cl100k = estimatorForFamily("openai-cl100k")
    expect(estimatorForOpenAIModel("gpt-4")).toBe(cl100k)
    expect(estimatorForOpenAIModel("gpt-3.5-turbo")).toBe(cl100k)
    expect(estimatorForOpenAIModel("gpt-4o")).toBe(estimatorForFamily("openai-o200k"))
  })
})
