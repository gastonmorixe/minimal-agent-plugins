/**
 * Title profile (title SPEC §4.3 R11): `recommendUtilityModel()`, the core
 * `resolveUtilityModel("opencode-zen")` and the DeepSeek V4.1 Flash price.
 * Pure: no network. Fake values only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import { buildOpenAIChatBody } from "@minimal-agent/core/plugin-api/llm/openai-chat"

import { resolveUtilityModel } from "../node_modules/@minimal-agent/core/src/llm/model-info.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
  setDefaultModelId,
} from "../node_modules/@minimal-agent/core/src/llm/model-registry.ts"

import { bootstrapOpencodeZen, opencodeZenAdapter } from "./adapter.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { ZEN_PRICING } from "./pricing.ts"

const PROFILE = {
  modelId: "deepseek-v4.1-flash",
  structured: "json_schema",
  effort: "low",
  stream: "required",
} as const

/** Register the OpenCode Zen catalog and adapter in the core registry. */
function bootCore(): void {
  bootstrapOpencodeZen({
    models: { register: (spec) => registerModel(spec), setDefault: setDefaultModelId },
    providers: {
      register: (a) => registerProvider(a as unknown as Parameters<typeof registerProvider>[0]),
    },
  })
}

function reset(): void {
  clearModelRegistry()
  clearProviderRegistry()
}

beforeEach(reset)
afterEach(reset)

describe("opencode-zen title profile", () => {
  it("recommends DeepSeek V4.1 Flash: JSON schema, effort low, streamed", () => {
    expect(opencodeZenAdapter.recommendUtilityModel?.()).toEqual(PROFILE)
  })

  it("core resolveUtilityModel gives V4.1 Flash with the profile and the price", () => {
    bootCore()
    expect(resolveUtilityModel("opencode-zen")).toEqual({
      ...PROFILE,
      providerId: "opencode-zen",
      pricing: { ...ZEN_PRICING["deepseek-v4.1-flash"] },
    })
  })

  it("has the live Zen price: $0.12 in, $0.48 out, $0.0024 cache read (60% off)", () => {
    expect(ZEN_PRICING["deepseek-v4.1-flash"]).toEqual({
      inputUSD: 0.12,
      outputUSD: 0.48,
      cacheReadUSD: 0.0024,
      cacheWriteUSD: 0,
      webSearchPerCallUSD: 0,
    })
  })

  it("sends reasoning_effort low and a JSON schema on the Chat body", () => {
    const reg = makeTestRegistry()
    bootstrapOpencodeZen({ models: reg.models, providers: reg.providers })
    const model = reg.resolveModel(PROFILE.modelId)
    expect(model.surfaceId).toBe("openai-chat-completions")
    expect(model.capabilities.structuredOutputs).toBe(true)
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    }
    const request: CanonicalRequest = {
      modelId: model.id,
      purpose: "title",
      messages: [userText("Why do basil leaves wilt?")],
      thinking: { mode: "off" },
      effort: PROFILE.effort,
      stream: true,
      outputFormat: { type: "json_schema", name: "session_title", schema, strict: true },
    }
    expect(opencodeZenAdapter.validate(request, model).ok).toBe(true)
    expect(buildOpenAIChatBody(request, model)).toMatchObject({
      model: "deepseek-v4.1-flash",
      reasoning_effort: "low",
      stream: true,
      response_format: { type: "json_schema", json_schema: { name: "session_title", schema } },
    })
  })
})
