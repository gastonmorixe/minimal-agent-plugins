/**
 * Meta Responses request-body offline tests.
 *
 * @module llm/providers/meta/responses/request-body.test
 */

import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

import { bootstrapMeta } from "../adapter.ts"
import type { CanonicalRequest } from "../lib/canonical-request.ts"
import { makeTestRegistry } from "../lib/test-registry.ts"

import { buildOpenAIResponsesBody, META_ENCRYPTED_REASONING_INCLUDE } from "./request-body.ts"

function setup() {
  const reg = makeTestRegistry()
  bootstrapMeta({ models: reg.models, providers: reg.providers })
  return reg
}

describe("Meta Responses request body", () => {
  it("defaults store:false and always includes encrypted reasoning", () => {
    const reg = setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const body = buildOpenAIResponsesBody(
      {
        modelId: "muse-spark-1.2",
        messages: [userText("hi")],
        effort: "high",
      },
      model,
    )
    expect(body.store).toBe(false)
    expect(body.include).toContain(META_ENCRYPTED_REASONING_INCLUDE)
    expect(body.reasoning?.effort).toBe("high")
    expect(body.model).toBe("muse-spark-1.2")
  })

  it("maps Muse effort levels including minimal and xhigh", () => {
    const reg = setup()
    const model = reg.resolveModel("muse-spark-1.2")
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      const body = buildOpenAIResponsesBody(
        {
          modelId: "muse-spark-1.2",
          messages: [userText("hi")],
          effort,
        },
        model,
      )
      expect(body.reasoning?.effort).toBe(effort)
    }
  })

  it("merges vendor.openai.include with encrypted reasoning", () => {
    const reg = setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const body = buildOpenAIResponsesBody(
      {
        modelId: "muse-spark-1.2",
        messages: [userText("hi")],
        vendor: { openai: { include: ["file_search_call.results"] } },
      },
      model,
    )
    expect(body.include).toContain(META_ENCRYPTED_REASONING_INCLUDE)
    expect(body.include).toContain("file_search_call.results")
  })

  it("drops previous_response_id when encrypted include is present", () => {
    const reg = setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const body = buildOpenAIResponsesBody(
      {
        modelId: "muse-spark-1.2",
        messages: [userText("hi")],
        previousResponseId: "resp_should_drop",
      },
      model,
    )
    expect(body.include).toContain(META_ENCRYPTED_REASONING_INCLUDE)
    expect(body.previous_response_id).toBeUndefined()
  })

  it("sends server tools on Responses (does not strip t.server)", () => {
    const reg = setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const req: CanonicalRequest = {
      modelId: "muse-spark-1.2",
      messages: [userText("search")],
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          inputSchema: { type: "object", properties: {} },
          server: "web_search",
        },
        {
          name: "local_tool",
          description: "Local",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }
    const body = buildOpenAIResponsesBody(req, model)
    expect(body.tools).toEqual(
      expect.arrayContaining([
        { type: "web_search" },
        expect.objectContaining({ type: "function", name: "local_tool" }),
      ]),
    )
  })

  it("opts into store:true from vendor.openai.store", () => {
    const reg = setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const body = buildOpenAIResponsesBody(
      {
        modelId: "muse-spark-1.2",
        messages: [userText("hi")],
        vendor: { openai: { store: true } },
      },
      model,
    )
    expect(body.store).toBe(true)
    // Encrypted include still wins over previous_response_id (mutual exclusion).
    expect(body.include).toContain(META_ENCRYPTED_REASONING_INCLUDE)
  })
})

describe("Responses text.format (SPEC-ONESHOT T4c)", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } }
  const req = (outputFormat: CanonicalRequest["outputFormat"]): CanonicalRequest => ({
    modelId: "muse-spark-1.3",
    messages: [userText("hi")],
    outputFormat,
  })

  it("sends a flat text.format and no response_format", () => {
    const model = setup().resolveModel("muse-spark-1.3")
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "title", schema, strict: true }),
      model,
    )
    expect("response_format" in body).toBe(false)
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "title", schema, strict: true },
    })
  })

  it("gates strict on capabilities.structuredOutputs", () => {
    const base = setup().resolveModel("muse-spark-1.3")
    const model = { ...base, capabilities: { ...base.capabilities, structuredOutputs: false } }
    const body = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "title", schema, strict: true }),
      model,
    )
    expect(body.text?.format).toEqual({ type: "json_schema", name: "title", schema })
    const loose = buildOpenAIResponsesBody(req({ type: "json_schema", name: "t", schema }), base)
    expect("strict" in (loose.text?.format ?? {})).toBe(false)
  })

  it("sanitizes the schema name", () => {
    const model = setup().resolveModel("muse-spark-1.3")
    const bad = buildOpenAIResponsesBody(req({ type: "json_schema", name: "a b.c", schema }), model)
    expect(bad.text?.format).toMatchObject({ name: "a_b_c" })
    const long = buildOpenAIResponsesBody(
      req({ type: "json_schema", name: "x".repeat(80), schema }),
      model,
    )
    expect(long.text?.format).toMatchObject({ name: "x".repeat(64) })
    const none = buildOpenAIResponsesBody(req({ type: "json_schema", schema }), model)
    expect(none.text?.format).toMatchObject({ name: "output" })
  })

  it("maps json_object and text", () => {
    const model = setup().resolveModel("muse-spark-1.3")
    expect(buildOpenAIResponsesBody(req({ type: "json_object" }), model).text).toEqual({
      format: { type: "json_object" },
    })
    expect(buildOpenAIResponsesBody(req({ type: "text" }), model).text).toEqual({
      format: { type: "text" },
    })
  })
})
