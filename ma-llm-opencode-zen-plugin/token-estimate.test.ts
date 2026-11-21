/**
 * Each OpenCode Zen model entry has the token estimator of the upstream
 * tokenizer family (from `ma-token-estimate-kit`), with `generic` for an
 * unknown id.
 */

import { describe, expect, it } from "bun:test"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { registerOpencodeZenModelInto, registerOpencodeZenModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("opencode-zen token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOpencodeZenModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("claude-opus-4-6")?.estimateTokens).toBe(estimatorForFamily("claude-legacy"))
    expect(specs.get("claude-opus-5-5")?.estimateTokens).toBe(estimatorForFamily("claude-5x"))
    expect(specs.get("gemini-3.8-flash")?.estimateTokens).toBe(estimatorForFamily("gemma"))
    expect(specs.get("muse-spark-1.3")?.estimateTokens).toBe(estimatorForFamily("meta-muse"))
    expect(specs.get("big-pickle")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })

  it("gives an ad-hoc model the family of its id", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOpencodeZenModelInto(registrar(specs) as never, "kimi-k4")
    expect(specs.get("kimi-k4")?.estimateTokens).toBe(estimatorForFamily("kimi"))
  })
})
