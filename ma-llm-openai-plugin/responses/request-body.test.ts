/**
 * Responses API output format mapping (SPEC-ONESHOT T4, D-6).
 *
 * The Responses API has no top-level `response_format`. Structured output
 * goes in `text.format`, flat: `{type:"json_schema", name, schema, strict?}`.
 */

import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"

import { buildOpenAIResponsesBody } from "./request-body.ts"

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }

function model(structuredOutputs: boolean): ModelEntry {
  return {
    id: "m",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "m",
    capabilities: { ...defaultCapabilities(), structuredOutputs },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
  } as ModelEntry
}

function req(outputFormat: CanonicalRequest["outputFormat"]): CanonicalRequest {
  return { modelId: "m", messages: [userText("hi")], outputFormat }
}

describe("buildOpenAIResponsesBody text.format", () => {
  it("sends a flat text.format and no response_format", () => {
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", schema: SCHEMA, strict: true, name: "result" }),
      model(true),
    )
    expect("response_format" in body).toBe(false)
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "result", schema: SCHEMA, strict: true },
    })
  })

  it("omits strict when the model does not support structured outputs", () => {
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", schema: SCHEMA, strict: true }),
      model(false),
    )
    expect(body.text).toEqual({ format: { type: "json_schema", name: "output", schema: SCHEMA } })
  })

  it("sanitizes the name", () => {
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", schema: SCHEMA, name: "a b/c" }),
      model(true),
    )
    expect(body.text?.format).toMatchObject({ name: "a_b_c" })
  })

  it("maps json_object and text to text.format {type}", () => {
    const obj = buildOpenAIResponsesBody(req({ type: "json_object" }), model(true))
    expect("response_format" in obj).toBe(false)
    expect(obj.text).toEqual({ format: { type: "json_object" } })
    const txt = buildOpenAIResponsesBody(req({ type: "text" }), model(true))
    expect(txt.text).toEqual({ format: { type: "text" } })
  })

  it("sets no text field without an output format", () => {
    const body = buildOpenAIResponsesBody(req(undefined), model(true))
    expect("text" in body).toBe(false)
    expect("response_format" in body).toBe(false)
  })
})
