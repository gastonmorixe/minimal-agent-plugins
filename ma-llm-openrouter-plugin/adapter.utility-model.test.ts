/**
 * Title profile (title SPEC §4.3 R11): `recommendUtilityModel()`, the core
 * `resolveUtilityModel("openrouter")` and the Ling 3.0 Tiny registry row.
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

import { bootstrapOpenRouter, openrouterAdapter } from "./adapter.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { PRICING_OR_LING_30_TINY } from "./pricing.ts"

const LING = "inclusionai/ling-3.0-tiny"

const PROFILE = { modelId: LING, structured: "json_schema", stream: "required" } as const

/** Register the OpenRouter catalog and adapter in the core registry. */
function bootCore(): void {
  bootstrapOpenRouter({
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

describe("openrouter title profile", () => {
  it("recommends Ling 3.0 Tiny: JSON schema, streamed, no effort", () => {
    expect(openrouterAdapter.recommendUtilityModel()).toEqual(PROFILE)
  })

  it("core resolveUtilityModel gives Ling with the profile and the price", () => {
    bootCore()
    expect(resolveUtilityModel("openrouter")).toEqual({
      ...PROFILE,
      providerId: "openrouter",
      pricing: { ...PRICING_OR_LING_30_TINY },
    })
  })

  it("sends no reasoning field: the row has no effort list for this adapter", () => {
    const reg = makeTestRegistry()
    bootstrapOpenRouter({ models: reg.models, providers: reg.providers })
    const model = reg.resolveModel(LING)
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
      stream: true,
      outputFormat: { type: "json_schema", name: "session_title", schema, strict: true },
    }
    expect(openrouterAdapter.validate(request, model).ok).toBe(true)
    const body = buildOpenAIChatBody(request, model)
    expect(body).toMatchObject({
      model: LING,
      stream: true,
      response_format: { type: "json_schema", json_schema: { name: "session_title", schema } },
    })
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body).not.toHaveProperty("reasoning")
  })
})

describe("openrouter Ling 3.0 Tiny registry row (live /api/v1/models, 2026-11-27)", () => {
  it("has the live price: $0.015 in, $0.045 out, $0.003 cache read per 1M tokens", () => {
    expect(PRICING_OR_LING_30_TINY).toEqual({
      inputUSD: 0.015,
      outputUSD: 0.045,
      cacheWriteUSD: 0,
      cacheReadUSD: 0.003,
      webSearchPerCallUSD: 0,
    })
  })

  it("has the live flags: structured output, tools, text input, 262K context, 250K out", () => {
    const reg = makeTestRegistry()
    bootstrapOpenRouter({ models: reg.models, providers: reg.providers })
    const m = reg.resolveModel(LING)
    expect(m.providerId).toBe("openrouter")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe(LING)
    expect(m.pricing).toEqual(PRICING_OR_LING_30_TINY)
    const c = m.capabilities
    expect(c.structuredOutputs).toBe(true)
    expect(c.tools.userDefined).toBe(true)
    expect(c.contextWindow).toBe(262_144)
    expect(c.maxOutputTokens).toBe(250_000)
    expect(c.modalities).toEqual({ image: false, audio: false, pdf: true, video: false })
    expect(c.acceptsTemperature).toBe(true)
    expect(c.acceptsTopP).toBe(true)
    expect(c.acceptsTopK).toBe(false)
    expect(c.acceptsSeed).toBe(true)
    expect(c.acceptsStopSequences).toBe(true)
    // No `reasoning_effort` and no `supported_efforts` on the live row.
    expect([...c.effort.levels]).toEqual([])
  })

  it("does not change the sub-agent role picks", () => {
    const reg = makeTestRegistry()
    bootstrapOpenRouter({ models: reg.models, providers: reg.providers })
    const recs = openrouterAdapter.recommendSubagentModels?.() ?? []
    expect(recs.find((r) => r.role === "scout")?.modelId).toBe("deepseek/deepseek-v4.1-flash")
    expect(recs.find((r) => r.role === "balanced")?.modelId).toBe("moonshotai/kimi-k3.1-pro")
  })
})
