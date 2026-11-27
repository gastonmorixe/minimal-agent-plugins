/**
 * Title profile (title SPEC §4.3 R11): `recommendUtilityModel()` and the core
 * `resolveUtilityModel("opencode-go")`. Pure: no network. Fake values only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { buildOpenAIChatBody } from "@minimal-agent/core/plugin-api/llm/openai-chat"

import { resolveUtilityModel } from "../node_modules/@minimal-agent/core/src/llm/model-info.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
  setDefaultModelId,
} from "../node_modules/@minimal-agent/core/src/llm/model-registry.ts"

import { bootstrapOpencode, opencodeAdapter } from "./adapter.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { PRICING_DEEPSEEK_V4_1_FLASH } from "./pricing.ts"

const PROFILE = {
  modelId: "deepseek-v4.1-flash",
  structured: "json_schema",
  effort: "low",
  stream: "required",
} as const

/** Register the OpenCode Go catalog and adapter in the core registry. */
function bootCore(): void {
  bootstrapOpencode({
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

describe("opencode-go title profile", () => {
  it("recommends DeepSeek V4.1 Flash: JSON schema, effort low, streamed", () => {
    expect(opencodeAdapter.recommendUtilityModel?.()).toEqual(PROFILE)
  })

  it("core resolveUtilityModel gives V4.1 Flash with the profile and the price", () => {
    bootCore()
    expect(resolveUtilityModel("opencode-go")).toEqual({
      ...PROFILE,
      providerId: "opencode-go",
      pricing: { ...PRICING_DEEPSEEK_V4_1_FLASH },
    })
  })

  it("sends reasoning_effort low and a JSON schema on the Chat body", () => {
    const reg = makeTestRegistry()
    bootstrapOpencode({ models: reg.models, providers: reg.providers })
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
    expect(opencodeAdapter.validate(request, model).ok).toBe(true)
    expect(buildOpenAIChatBody(request, model)).toMatchObject({
      model: "deepseek-v4.1-flash",
      reasoning_effort: "low",
      stream: true,
      response_format: { type: "json_schema", json_schema: { name: "session_title", schema } },
    })
  })
})
