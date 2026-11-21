/**
 * Each OpenCode Go model entry has the token estimator of the upstream
 * tokenizer family (from `ma-token-estimate-kit`), with `generic` for an
 * unknown id.
 */

import { describe, expect, it } from "bun:test"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { registerOpencodeModelInto, registerOpencodeModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("opencode-go token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerOpencodeModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("claude-haiku-5-5")?.estimateTokens).toBe(estimatorForFamily("claude-5x"))
    expect(specs.get("qwen3.8-max")?.estimateTokens).toBe(estimatorForFamily("qwen"))
    expect(specs.get("glm-5.3")?.estimateTokens).toBe(estimatorForFamily("glm"))
    expect(specs.get("step-5-preview")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })

  it("gives an ad-hoc model the family of its id", () => {
    const specs = new Map<string, ProviderModelSpec>()
    const base = {
      providerId: "opencode-go",
      displayName: "x",
      surfaceId: "openai-chat-completions",
      capabilities: {} as never,
      pricing: {} as never,
    } as const
    registerOpencodeModelInto(registrar(specs) as never, { ...base, id: "deepseek-v9" })
    registerOpencodeModelInto(registrar(specs) as never, { ...base, id: "unknown-model-1" })
    expect(specs.get("deepseek-v9")?.estimateTokens).toBe(estimatorForFamily("deepseek"))
    expect(specs.get("unknown-model-1")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
