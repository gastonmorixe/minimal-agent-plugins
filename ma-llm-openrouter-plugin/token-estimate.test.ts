/**
 * Each OpenRouter model entry has the token estimator of the upstream
 * tokenizer family (from `ma-token-estimate-kit`), with `generic` for an
 * unknown slug.
 */

import { describe, expect, it } from "bun:test"

import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import { registerOpenRouterModelInto, registerOpenRouterModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("openrouter token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOpenRouterModels(registrar(specs))
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("anthropic/claude-opus-5.5")?.estimateTokens).toBe(
      estimatorForFamily("claude-5x"),
    )
    expect(specs.get("moonshotai/kimi-k3.1-pro")?.estimateTokens).toBe(estimatorForFamily("kimi"))
    expect(specs.get("x-ai/grok-4.7")?.estimateTokens).toBe(estimatorForFamily("grok"))
    expect(specs.get("openai/gpt-4o-mini")?.estimateTokens).toBe(estimatorForFamily("openai-o200k"))
  })

  it("uses the generic family for an unknown ad-hoc slug", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOpenRouterModelInto(registrar(specs), { id: "nvidia/nemotron-nano-9b" })
    expect(specs.get("nvidia/nemotron-nano-9b")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
