/**
 * The `tokenizer` config (`MINIMAL_AGENT_TOKENIZER`) and the token estimator
 * of a generic-endpoint model.
 */

import { describe, expect, it } from "bun:test"

import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type {
  SurfaceCodec,
  SurfaceCodecRegistry,
} from "@minimal-agent/core/plugin-api/llm/surface-codec"

import { estimatorForFamily } from "../ma-token-estimate-kit/src/index.ts"

import {
  bootstrapGenericEndpoint,
  genericEndpointEstimator,
  registerGenericEndpointAdHocModel,
} from "./adapter.ts"
import { readGenericEndpointConfig } from "./config.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

const BASE_ENV = {
  MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
  MINIMAL_AGENT_FORMAT: "openai-chat-completions",
}

describe("tokenizer config", () => {
  it("reads a valid family name (any case)", () => {
    const cfg = readGenericEndpointConfig({ ...BASE_ENV, MINIMAL_AGENT_TOKENIZER: " Qwen " })
    expect(cfg.tokenizer).toBe("qwen")
  })

  it("throws a clear error for an unknown name", () => {
    expect(() =>
      readGenericEndpointConfig({ ...BASE_ENV, MINIMAL_AGENT_TOKENIZER: "gpt2" }),
    ).toThrow(/unknown tokenizer "gpt2".*Valid names: .*generic/)
  })

  it("is absent when not set", () => {
    const cfg = readGenericEndpointConfig({ ...BASE_ENV })
    expect("tokenizer" in cfg).toBe(false)
  })
})

describe("genericEndpointEstimator", () => {
  it("uses the configured family first", () => {
    expect(genericEndpointEstimator("qwen3-coder", undefined, "llama3")).toBe(
      estimatorForFamily("llama3"),
    )
  })

  it("uses the family of the model id, then of the provider model", () => {
    expect(genericEndpointEstimator("qwen3-coder", undefined, undefined)).toBe(
      estimatorForFamily("qwen"),
    )
    expect(genericEndpointEstimator("local", "deepseek-v4", undefined)).toBe(
      estimatorForFamily("deepseek"),
    )
  })

  it("uses the codec estimator, else generic, for an unknown id", () => {
    const codecEstimator = (text: string) => text.length
    expect(genericEndpointEstimator("local", undefined, undefined, codecEstimator)).toBe(
      codecEstimator,
    )
    expect(genericEndpointEstimator("local", undefined, undefined)).toBe(
      estimatorForFamily("generic"),
    )
  })
})

describe("ad-hoc model estimator", () => {
  function register(env: Record<string, string>, modelId: string) {
    const keys = [
      "MINIMAL_AGENT_ENDPOINT",
      "MINIMAL_AGENT_FORMAT",
      "MINIMAL_AGENT_SURFACE",
      "MINIMAL_AGENT_PROVIDER_MODEL",
      "MINIMAL_AGENT_EFFORT_LEVELS",
      "MINIMAL_AGENT_IMAGE_INPUT",
      "MINIMAL_AGENT_TOKENIZER",
    ]
    const prev: Record<string, string | undefined> = {}
    for (const k of keys) {
      prev[k] = process.env[k]
      delete process.env[k]
    }
    Object.assign(process.env, env)
    try {
      const codec: SurfaceCodec = {
        surfaceId: "mock-surface",
        displayName: "Mock",
        defaultPath: "/v1/chat/completions",
        defaultCapabilities: defaultCapabilities(),
        defaultPricing: {
          inputUSD: 0,
          outputUSD: 0,
          cacheWriteUSD: 0,
          cacheReadUSD: 0,
          webSearchPerCallUSD: 0,
        },
        validate: () => ({ ok: true, errors: [] }),
        buildRequest: ({ endpoint }) => ({ label: "mock", method: "POST", url: endpoint }),
        async *translateStream() {},
      }
      const codecs: SurfaceCodecRegistry = {
        register: () => {},
        find: (id: string) => (id === codec.surfaceId ? codec : undefined),
        list: () => [codec],
      }
      const registry = makeTestRegistry()
      bootstrapGenericEndpoint({
        models: registry.models,
        providers: registry.providers,
        surfaceCodecs: codecs,
      })
      registerGenericEndpointAdHocModel(modelId)
      return registry.resolveModel(modelId)
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
    }
  }

  const env = {
    MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
    MINIMAL_AGENT_FORMAT: "mock-surface",
  }

  it("sets the configured family on the model", () => {
    const model = register({ ...env, MINIMAL_AGENT_TOKENIZER: "mistral" }, "local-model")
    expect(model.estimateTokens).toBe(estimatorForFamily("mistral"))
  })

  it("sets the family of the id when the config is absent", () => {
    expect(register(env, "glm-5.3").estimateTokens).toBe(estimatorForFamily("glm"))
    expect(register(env, "local-model").estimateTokens).toBe(estimatorForFamily("generic"))
  })
})
