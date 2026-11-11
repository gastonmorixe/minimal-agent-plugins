/**
 * Chat Completions `response_format` mapping (SPEC-ONESHOT T4, R4, D-4).
 *
 * Shape: `{type:"json_schema", json_schema:{name, schema, strict?}}`.
 * `strict: true` only when the request asks for it AND the model has
 * `structuredOutputs`. Name: `outputFormat.name` or "output", sanitized to
 * `[a-zA-Z0-9_-]{1,64}`.
 */

import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"

import { buildOpenAIChatBody } from "./request-body.ts"

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }

function model(structuredOutputs: boolean): ModelEntry {
  return {
    id: "m",
    providerId: "openai",
    surfaceId: "openai-chat-completions",
    displayName: "m",
    capabilities: { ...defaultCapabilities(), structuredOutputs },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
  } as ModelEntry
}

function req(outputFormat: CanonicalRequest["outputFormat"]): CanonicalRequest {
  return { modelId: "m", messages: [userText("hi")], outputFormat }
}

describe("buildOpenAIChatBody response_format", () => {
  it("sends strict true when asked and the model supports structured outputs", () => {
    const body = buildOpenAIChatBody(
      req({ type: "json_schema", schema: SCHEMA, strict: true, name: "result" }),
      model(true),
    )
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "result", schema: SCHEMA, strict: true },
    })
  })

  it("omits strict when the model does not support structured outputs", () => {
    const body = buildOpenAIChatBody(
      req({ type: "json_schema", schema: SCHEMA, strict: true }),
      model(false),
    )
    const fmt = body.response_format as { json_schema: Record<string, unknown> }
    expect("strict" in fmt.json_schema).toBe(false)
  })

  it("omits strict when not asked", () => {
    const body = buildOpenAIChatBody(req({ type: "json_schema", schema: SCHEMA }), model(true))
    const fmt = body.response_format as { json_schema: Record<string, unknown> }
    expect("strict" in fmt.json_schema).toBe(false)
  })

  it("falls back to the name 'output'", () => {
    const body = buildOpenAIChatBody(req({ type: "json_schema", schema: SCHEMA }), model(true))
    const fmt = body.response_format as { json_schema: { name: string } }
    expect(fmt.json_schema.name).toBe("output")
  })

  it("sanitizes the name and caps it at 64 chars", () => {
    const bad = buildOpenAIChatBody(
      req({ type: "json_schema", schema: SCHEMA, name: "my schema.v1!" }),
      model(true),
    )
    expect((bad.response_format as { json_schema: { name: string } }).json_schema.name).toBe(
      "my_schema_v1_",
    )
    const long = buildOpenAIChatBody(
      req({ type: "json_schema", schema: SCHEMA, name: "x".repeat(100) }),
      model(true),
    )
    expect((long.response_format as { json_schema: { name: string } }).json_schema.name).toBe(
      "x".repeat(64),
    )
  })

  it("keeps json_object as is", () => {
    const body = buildOpenAIChatBody(req({ type: "json_object" }), model(true))
    expect(body.response_format).toEqual({ type: "json_object" })
  })
})
