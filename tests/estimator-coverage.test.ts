/**
 * Each static model entry with `outputTokensShareContextWindow: true` in the
 * `ma-llm-*` plugins has a token estimator (`estimateTokens`).
 *
 * Such a model clamps `max_tokens` to the room that is left after the
 * request input. With no estimator, core uses the UTF-8 byte count as an
 * upper bound of the input tokens. That bound is 3 to 4 times too high, so
 * the clamp can go down to the floor of 1024 output tokens.
 *
 * The generic-endpoint plugin has no static entries (its models come from
 * the user config, with `MINIMAL_AGENT_TOKENIZER`), so it is not here.
 */

import { describe, expect, it } from "bun:test"

import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { registerAnthropicModels } from "../ma-llm-anthropic-plugin/models.ts"
import { registerClinepassModels } from "../ma-llm-clinepass-plugin/models.ts"
import { registerCursorModels } from "../ma-llm-cursor-plugin/models.ts"
import { registerGrokModels } from "../ma-llm-grok-plugin/models.ts"
import { registerHuggingFaceModels } from "../ma-llm-huggingface-plugin/models.ts"
import { registerMetaModels } from "../ma-llm-meta-plugin/models.ts"
import { registerOllamaModels } from "../ma-llm-ollama-plugin/models.ts"
import { registerOpenAIModels } from "../ma-llm-openai-plugin/models.ts"
import { registerOpencodeModels } from "../ma-llm-opencode-go-plugin/models.ts"
import { registerOpencodeZenModels } from "../ma-llm-opencode-zen-plugin/models.ts"
import { registerOpenRouterModels } from "../ma-llm-openrouter-plugin/models.ts"
import { registerWaferModels } from "../ma-llm-wafer-plugin/models.ts"

/** The static registration function of each `ma-llm-*` plugin. */
const PLUGINS: ReadonlyArray<readonly [string, (registrar: ModelRegistrar) => unknown]> = [
  ["anthropic", registerAnthropicModels],
  ["clinepass", registerClinepassModels],
  ["cursor", registerCursorModels],
  ["grok", registerGrokModels],
  ["huggingface", registerHuggingFaceModels],
  ["meta", registerMetaModels],
  ["ollama", registerOllamaModels],
  ["openai", registerOpenAIModels],
  ["opencode-go", registerOpencodeModels],
  ["opencode-zen", registerOpencodeZenModels],
  ["openrouter", registerOpenRouterModels],
  ["wafer", registerWaferModels],
]

/** The entries that one registration function gives. */
function staticSpecs(register: (registrar: ModelRegistrar) => unknown): ProviderModelSpec[] {
  const specs: ProviderModelSpec[] = []
  register({ register: (spec) => specs.push(spec), setDefault: () => {} })
  return specs
}

describe("estimator coverage of shared-window models", () => {
  for (const [name, register] of PLUGINS) {
    it(`${name}: each shared-window static entry has estimateTokens`, () => {
      const specs = staticSpecs(register)
      expect(specs.length).toBeGreaterThan(0)
      const missing = specs
        .filter((s) => s.capabilities.outputTokensShareContextWindow)
        .filter((s) => typeof s.estimateTokens !== "function")
        .map((s) => `${s.providerId}/${s.id}`)
      expect(missing).toEqual([])
    })
  }

  it("the check is not empty: some static entries share the window", () => {
    const shared = PLUGINS.flatMap(([, register]) => staticSpecs(register)).filter(
      (s) => s.capabilities.outputTokensShareContextWindow,
    )
    expect(shared.length).toBeGreaterThan(0)
  })
})
