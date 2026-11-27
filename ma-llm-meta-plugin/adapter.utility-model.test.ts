/**
 * Title profile (title SPEC §4.3 R11): `recommendUtilityModel()` and the core
 * `resolveUtilityModel("meta")`. Pure: no network. Fake values only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

import { resolveUtilityModel } from "../node_modules/@minimal-agent/core/src/llm/model-info.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
  setDefaultModelId,
} from "../node_modules/@minimal-agent/core/src/llm/model-registry.ts"

import { bootstrapMeta, metaAdapter, metaProviderPlugin } from "./adapter.ts"
import { readMuseOAuthAuth } from "./auth.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { PRICING_MUSE_EMBER_1_0 } from "./pricing.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"

const PROFILE = {
  modelId: "muse-ember-1.0",
  structured: "json_schema",
  effort: "low",
  stream: "required",
} as const

/** Register the Meta catalog and adapter in the core registry. */
function bootCore(): void {
  bootstrapMeta({
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

describe("meta title profile", () => {
  it("recommends Muse Ember 1.0: JSON schema, effort low, streamed", () => {
    expect(metaAdapter.recommendUtilityModel?.()).toEqual(PROFILE)
  })

  it("serves both credentials: the API key and the Muse OAuth login use one provider", () => {
    expect(metaProviderPlugin.id).toBe("meta")
    expect(metaProviderPlugin.apiKeyAuth).toBeDefined()
    expect(metaProviderPlugin.oauthLogin).toBeDefined()
    // A Muse login keeps a minted Model API key: it is sent as an api-key.
    expect(readMuseOAuthAuth({ apiKey: "fake-minted-key" })).toEqual({
      kind: "api-key",
      key: "fake-minted-key",
    })
    expect(metaAdapter.recommendUtilityModel?.()?.modelId).toBe("muse-ember-1.0")
  })

  it("core resolveUtilityModel gives Ember with the profile and the price", () => {
    bootCore()
    expect(resolveUtilityModel("meta")).toEqual({
      ...PROFILE,
      providerId: "meta",
      pricing: { ...PRICING_MUSE_EMBER_1_0 },
    })
  })

  it("sends effort low on the title body, because Ember defaults to max", () => {
    const reg = makeTestRegistry()
    bootstrapMeta({ models: reg.models, providers: reg.providers })
    const profile = metaAdapter.recommendUtilityModel?.()
    if (!profile) throw new Error("Meta has no title profile")
    const model = reg.resolveModel(profile.modelId)
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
      effort: profile.effort,
      stream: profile.stream === "required",
      outputFormat: { type: "json_schema", name: "session_title", schema, strict: true },
    }
    expect(buildOpenAIResponsesBody(request, model)).toMatchObject({
      model: "muse-ember-1.0",
      reasoning: { effort: "low" },
      stream: true,
      text: { format: { type: "json_schema", name: "session_title", schema } },
    })
  })
})
