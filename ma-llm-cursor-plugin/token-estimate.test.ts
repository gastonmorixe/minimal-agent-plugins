/**
 * Each cursor model entry has the token estimator of the upstream tokenizer
 * family (from `ma-token-estimate-kit`), with `generic` for an unknown id.
 */

import { describe, expect, it } from "bun:test"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { registerCursorAdHocModelInto, registerCursorModels } from "./models.ts"

function registrar(specs: Map<string, ProviderModelSpec>) {
  return { register: (spec: ProviderModelSpec) => specs.set(spec.id, spec), setDefault: () => {} }
}

describe("cursor token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerCursorModels(registrar(specs) as never)
    expect(specs.size).toBeGreaterThan(0)
    for (const spec of specs.values()) expect(typeof spec.estimateTokens).toBe("function")
    expect(specs.get("cursor-grok-4.7")?.estimateTokens).toBe(estimatorForFamily("grok"))
    expect(specs.get("cursor-gpt-4")?.estimateTokens).toBe(estimatorForFamily("openai-cl100k"))
    expect(specs.get("cursor-auto")?.estimateTokens).toBe(estimatorForFamily("generic"))
    expect(specs.get("cursor-composer-2.5")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })

  it("gives an ad-hoc model the family of its id, else generic", () => {
    const specs = new Map<string, ProviderModelSpec>()
    registerCursorAdHocModelInto(registrar(specs) as never, "claude-opus-6")
    registerCursorAdHocModelInto(registrar(specs) as never, "mystery-model")
    expect(specs.get("cursor-claude-opus-6")?.estimateTokens).toBe(estimatorForFamily("claude-5x"))
    expect(specs.get("cursor-mystery-model")?.estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
