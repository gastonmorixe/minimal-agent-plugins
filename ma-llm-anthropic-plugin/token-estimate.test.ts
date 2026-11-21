/**
 * Each Anthropic model entry has the token estimator of its tokenizer family
 * (from `ma-token-estimate-kit`).
 */

import { describe, expect, it } from "bun:test"

import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import { registerAnthropicAdHocModelInto, registerAnthropicModels } from "./models.ts"

function capture(): {
  specs: ProviderModelSpec[]
  registrar: Parameters<typeof registerAnthropicModels>[0]
} {
  const specs: ProviderModelSpec[] = []
  return {
    specs,
    registrar: { register: (spec) => specs.push(spec), setDefault: () => {} },
  }
}

describe("anthropic token estimators", () => {
  it("gives an estimator to each static model entry", () => {
    const { specs, registrar } = capture()
    registerAnthropicModels(registrar)
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) expect(typeof spec.estimateTokens).toBe("function")
  })

  it("uses claude-5x for 4.7 and later, claude-legacy for 4.6 and earlier", () => {
    const { specs, registrar } = capture()
    registerAnthropicModels(registrar)
    const byId = new Map(specs.map((s) => [s.id, s]))
    expect(byId.get("claude-opus-5-5")?.estimateTokens).toBe(estimatorForFamily("claude-5x"))
    expect(byId.get("claude-opus-4-7")?.estimateTokens).toBe(estimatorForFamily("claude-5x"))
    expect(byId.get("claude-sonnet-4-6")?.estimateTokens).toBe(estimatorForFamily("claude-legacy"))
    expect(byId.get("claude-haiku-4-5-20251001")?.estimateTokens).toBe(
      estimatorForFamily("claude-legacy"),
    )
  })

  it("gives an ad-hoc model the family of its id", () => {
    const { specs, registrar } = capture()
    registerAnthropicAdHocModelInto(registrar, "claude-opus-6-1")
    registerAnthropicAdHocModelInto(registrar, "claude-3-5-sonnet-20241022")
    expect(specs[0]?.estimateTokens).toBe(estimatorForFamily("claude-5x"))
    expect(specs[1]?.estimateTokens).toBe(estimatorForFamily("claude-legacy"))
  })
})
