import { describe, expect, test } from "bun:test"

import { makeCharClassEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"

import {
  estimatorForFamily,
  estimatorForModelId,
  familyForModelId,
  TOKENIZER_FAMILIES,
  TOKENIZER_PRESETS,
  type TokenizerFamily,
} from "./index.ts"

/** Fixed sample strings, one for each text kind. */
const SAMPLES = {
  prose:
    "The quick brown fox jumps over the lazy dog. A token estimator gives an approximate count of tokens for a piece of text, so the agent can plan the context budget before it sends a request to the model.",
  code: "export function add(a: number, b: number): number {\n  const total = a + b\n  if (total > 100) {\n    throw new RangeError(`too big: ${total}`)\n  }\n  return total\n}\n",
  json: '{"model":"claude-opus-5","messages":[{"role":"user","content":[{"type":"text","text":"hello world"}]}],"max_tokens":4096,"stream":true}',
  cjk: "日本語のテキストを解析します。中文文本的分词与英文不同。한국어 문장도 포함합니다。",
  emoji: "🎉🚀✨ party time 😀👍🏽🔥 done ✅❌",
} as const

/** Expected chars/token band for each kind, for all families. */
const BANDS: Record<keyof typeof SAMPLES, [number, number]> = {
  prose: [2.5, 6],
  code: [2.2, 4.5],
  json: [2.2, 4.5],
  cjk: [0.7, 2.5],
  emoji: [0.8, 3.5],
}

/** Exact o200k_base counts of the samples (tiktoken). */
const O200K_EXACT: Record<keyof typeof SAMPLES, number> = {
  prose: 42,
  code: 49,
  json: 41,
  cjk: 27,
  emoji: 16,
}

describe("presets", () => {
  test("each preset is valid for the core factory", () => {
    for (const family of TOKENIZER_FAMILIES) {
      expect(() => makeCharClassEstimator(TOKENIZER_PRESETS[family])).not.toThrow()
    }
    expect(TOKENIZER_FAMILIES.length).toBe(16)
  })

  for (const family of TOKENIZER_FAMILIES) {
    test(`${family}: each sample is in the chars/token band`, () => {
      const estimate = estimatorForFamily(family)
      expect(estimate("")).toBe(0)
      for (const [kind, text] of Object.entries(SAMPLES) as Array<[keyof typeof SAMPLES, string]>) {
        const tokens = estimate(text)
        expect(Number.isInteger(tokens)).toBe(true)
        const ratio = text.length / tokens
        const [lo, hi] = BANDS[kind]
        if (ratio < lo || ratio > hi) {
          throw new Error(`${family} ${kind}: ${ratio.toFixed(2)} chars/token is not in [${lo}, ${hi}]`)
        }
      }
    })
  }

  test("openai-o200k is within 15% of the exact o200k count", () => {
    const estimate = estimatorForFamily("openai-o200k")
    for (const [kind, text] of Object.entries(SAMPLES) as Array<[keyof typeof SAMPLES, string]>) {
      const exact = O200K_EXACT[kind]
      expect(Math.abs(estimate(text) - exact) / exact).toBeLessThan(0.15)
    }
  })

  test("claude-5x gives more tokens than claude-legacy, and both more than o200k on prose", () => {
    const text = SAMPLES.prose.repeat(20)
    const c5 = estimatorForFamily("claude-5x")(text)
    const legacy = estimatorForFamily("claude-legacy")(text)
    const o200k = estimatorForFamily("openai-o200k")(text)
    expect(c5).toBeGreaterThan(legacy)
    expect(legacy).toBeGreaterThan(o200k)
  })
})

describe("familyForModelId", () => {
  /** Real model ids of the ma-llm-* plugins, and some aggregator forms. */
  const CASES: Array<[string, TokenizerFamily | undefined]> = [
    // anthropic
    ["claude-haiku-5-5", "claude-5x"],
    ["claude-sonnet-5-5", "claude-5x"],
    ["claude-opus-5-5", "claude-5x"],
    ["claude-opus-5", "claude-5x"],
    ["claude-fable-5-2", "claude-5x"],
    ["claude-opus-4-8", "claude-5x"],
    ["claude-opus-4-7", "claude-5x"],
    ["claude-opus-4-7[1m]", "claude-5x"],
    ["claude-opus-4-6", "claude-legacy"],
    ["claude-sonnet-4-6", "claude-legacy"],
    ["claude-opus-4-5-20251101", "claude-legacy"],
    ["claude-haiku-4-5-20251001", "claude-legacy"],
    ["claude-sonnet-4-20250514", "claude-legacy"],
    ["claude-3-5-sonnet-20241022", "claude-legacy"],
    // openai
    ["gpt-6.2-sol", "openai-o200k"],
    ["gpt-5.6-terra-chat", "openai-o200k"],
    ["gpt-5", "openai-o200k"],
    ["o3", "openai-o200k"],
    ["o4-mini", "openai-o200k"],
    ["gpt-4.1", "openai-o200k"],
    ["gpt-4o", "openai-o200k"],
    ["gpt-4o-mini", "openai-o200k"],
    ["gpt-oss:120b", "openai-o200k"],
    ["openai/gpt-oss-20b", "openai-o200k"],
    ["gpt-4-turbo", "openai-cl100k"],
    ["gpt-3.5-turbo", "openai-cl100k"],
    // clinepass
    ["cline-pass/glm-5.2", "glm"],
    ["cline-pass/kimi-k3", "kimi"],
    ["cline-pass/deepseek-v4-pro", "deepseek"],
    ["cline-pass/minimax-m3", "minimax"],
    ["cline-pass/qwen3.7-max", "qwen"],
    ["cline-pass/mimo-v2.5-pro", undefined],
    // cursor
    ["cursor-auto", undefined],
    ["cursor-grok-4.5-high-fast", "grok"],
    ["cursor-gpt-5.6-sol-max-fast", "openai-o200k"],
    // grok
    ["grok-4.7", "grok"],
    ["grok-build-chat", "grok"],
    ["grok-4.20-reasoning", "grok"],
    // huggingface
    ["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek"],
    ["moonshotai/Kimi-K3.1-Pro", "kimi"],
    ["zai-org/GLM-5.3", "glm"],
    ["MiniMaxAI/MiniMax-M3", "minimax"],
    // meta
    ["muse-spark-1.3-contributor", "meta-muse"],
    ["muse-wonder-1.0-chat", "meta-muse"],
    ["muse-ember-1.0", "meta-muse"],
    // ollama
    ["deepseek-v4-pro:0813", "deepseek"],
    ["glm-5.3-flash", "glm"],
    ["minimax-m3.1-flash", "minimax"],
    ["kimi-k2.7-code", "kimi"],
    ["gemma4:31b", "gemma"],
    ["nemotron-3-ultra", undefined],
    ["llama3.1:8b", "llama3"],
    // openrouter and other aggregators
    ["moonshotai/kimi-k3.1-pro", "kimi"],
    ["anthropic/claude-sonnet-5.5", "claude-5x"],
    ["anthropic/claude-opus-4.5", "claude-legacy"],
    ["openrouter/anthropic/claude-opus-5.5", "claude-5x"],
    ["openai/gpt-6.2-sol", "openai-o200k"],
    ["x-ai/grok-4.7", "grok"],
    ["google/gemini-2.5-pro", "gemma"],
    ["meta-llama/llama-3.3-70b-instruct", "llama3"],
    ["meta-llama/Llama-4-Maverick-17B-128E-Instruct", "llama4"],
    ["qwen/qwen3-coder", "qwen"],
    ["mistralai/devstral-small-2505", "mistral"],
    ["codestral-latest", "mistral"],
    ["z-ai/glm-4.6", "glm"],
    ["accounts/fireworks/models/deepseek-v3p1", "deepseek"],
    ["accounts/fireworks/models/kimi-k2-instruct", "kimi"],
    // wafer
    ["GLM-5.3-Flash", "glm"],
    ["Kimi-K3.1-Pro-US", "kimi"],
    ["DeepSeek-V4-Flash-0731-Fast", "deepseek"],
    ["Qwen3.8-27B", "qwen"],
    // generic endpoint (Hugging Face cache name)
    ["mlx-community--Qwen3.6-35B-A3B-4bit", "qwen"],
    // org only
    ["openai/some-future-model", "openai-o200k"],
    ["unknown-model", undefined],
  ]

  for (const [id, family] of CASES) {
    test(`${id} -> ${String(family)}`, () => {
      expect(familyForModelId(id)).toBe(family)
    })
  }
})

describe("memoization", () => {
  test("estimatorForFamily gives the same function each time", () => {
    for (const family of TOKENIZER_FAMILIES) {
      expect(estimatorForFamily(family)).toBe(estimatorForFamily(family))
    }
  })

  test("estimatorForModelId uses the family estimator", () => {
    expect(estimatorForModelId("claude-opus-5-5")).toBe(estimatorForFamily("claude-5x"))
    expect(estimatorForModelId("openrouter/qwen/qwen3-coder")).toBe(estimatorForFamily("qwen"))
  })

  test("estimatorForModelId uses the fallback only when no rule agrees", () => {
    expect(estimatorForModelId("cursor-auto")).toBeUndefined()
    expect(estimatorForModelId("cursor-auto", "generic")).toBe(estimatorForFamily("generic"))
    expect(estimatorForModelId("grok-4.7", "generic")).toBe(estimatorForFamily("grok"))
  })
})
