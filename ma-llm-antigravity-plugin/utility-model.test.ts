/**
 * Title side call on Antigravity: the utility profile, the JSON schema wire
 * fields, and validation.
 *
 * Wire fields: gemini-cli sends `generationConfig.responseMimeType` and
 * `generationConfig.responseJsonSchema` on the same Cloud Code Assist
 * `v1internal` API (`packages/core/src/code_assist/converter.ts`
 * `toVertexGenerationConfig`, and `packages/core/src/core/baseLlmClient.ts`
 * `generateJson`, https://github.com/google-gemini/gemini-cli).
 *
 * No network: a fake client records the request and answers one SSE frame.
 * All tokens and ids are test values.
 *
 * @module utility-model.test
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { sendOptionsToCanonical } from "../node_modules/@minimal-agent/core/src/llm/codec/request-codec.ts"
import { resolveUtilityModel } from "../node_modules/@minimal-agent/core/src/llm/model-info.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
} from "../node_modules/@minimal-agent/core/src/llm/model-registry.ts"
import { buildProviderSetupContext } from "../node_modules/@minimal-agent/core/src/llm/provider-discovery.ts"

import {
  antigravityAdapter,
  bootstrapAntigravity,
  clearAntigravityAdapterState,
} from "./adapter.ts"
import type { ModelView } from "./lib/host-types.ts"
import { clearAntigravityLiveModelsCache } from "./live-models.ts"
import {
  antigravitySpecsFromCatalog,
  type CatalogResponse,
  findAntigravityModel,
} from "./models.ts"
import { buildAntigravityBody } from "./request-body.ts"
import { validateAntigravityRequest } from "./validate.ts"

/** The title schema shape (`ma-title-plugin/lib/generate.ts` `TITLE_SCHEMA`). */
const SCHEMA = {
  type: "object",
  properties: { title: { type: "string", description: "A title of 2 to 6 words" } },
  required: ["title"],
  additionalProperties: false,
}

function row(id: string): ModelView {
  const found = findAntigravityModel(id)
  if (!found) throw new Error(`test fixture: no catalog row for ${id}`)
  return found as ModelView
}

/** A title request as core makes it: `outputConfig.format` through the core codec. */
function titleRequest(modelId = "gemini-4-hydrogen"): CanonicalRequest {
  return sendOptionsToCanonical({
    auth: { kind: "oauth", token: "test-token" },
    model: modelId,
    selectedProviderId: "antigravity",
    system: [{ type: "text", text: "Write a short title. Reply with JSON only." }],
    messages: [{ role: "user", content: [{ type: "text", text: "<session>\nhi\n</session>" }] }],
    maxTokens: 256,
    stream: true,
    requestType: "title",
    thinking: false,
    outputConfig: { effort: "low", format: { type: "json_schema", schema: SCHEMA, strict: true } },
  } as never)
}

type Body = {
  model: string
  request: { generationConfig: Record<string, unknown> }
}

function bodyOf(req: CanonicalRequest, model: ModelView): Body {
  return buildAntigravityBody(req, model, {
    project: "test-project",
    modelId: model.vendorIds?.model ?? model.id,
    requestId: "agent/1/2/0/0",
  }).body as Body
}

describe("antigravity recommendUtilityModel", () => {
  it("recommends gemini-4-hydrogen with JSON schema output, thinking off, effort low, stream", () => {
    expect(antigravityAdapter.recommendUtilityModel()).toEqual({
      modelId: "gemini-4-hydrogen",
      structured: "json_schema",
      thinkingOff: true,
      effort: "low",
      stream: "required",
    })
  })
})

describe("core resolveUtilityModel for antigravity", () => {
  beforeAll(() => {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapAntigravity(buildProviderSetupContext())
  })

  afterAll(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("gives the Hydrogen family row, at plan price 0, under the default ceilings", () => {
    expect(resolveUtilityModel("antigravity")).toEqual({
      modelId: "gemini-4-hydrogen",
      providerId: "antigravity",
      structured: "json_schema",
      thinkingOff: true,
      effort: "low",
      stream: "required",
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
  })
})

describe("JSON schema on the wire", () => {
  it("sends the JSON mime type and the schema in generationConfig for a title request", () => {
    const body = bodyOf(titleRequest(), row("gemini-4-hydrogen"))
    // Effort low on the family row, and no thinkingConfig for thinking off.
    expect(body.model).toBe("gemini-4-hydrogen-low")
    expect(body.request.generationConfig).toEqual({
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseJsonSchema: SCHEMA,
    })
  })

  it("sends standard lower-case JSON Schema, not the upper-case tool schema", () => {
    const body = bodyOf(titleRequest(), row("gemini-4-hydrogen"))
    const schema = body.request.generationConfig.responseJsonSchema as { type: string }
    expect(schema.type).toBe("object")
    expect(body.request.generationConfig).not.toHaveProperty("responseSchema")
  })

  it("adds no schema field to a normal turn with no format", () => {
    const req: CanonicalRequest = {
      modelId: "gemini-4-hydrogen",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      generation: { maxOutputTokens: 256 },
    }
    const config = bodyOf(req, row("gemini-4-hydrogen")).request.generationConfig
    expect(config).not.toHaveProperty("responseMimeType")
    expect(config).not.toHaveProperty("responseJsonSchema")
  })

  it("sends the fields on the wire and reads the raw JSON text back (adapter run)", async () => {
    clearAntigravityAdapterState()
    clearAntigravityLiveModelsCache()
    const sent: string[] = []
    const frame = `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: '{"title":"Fix the login bug"}' }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, totalTokenCount: 48 },
      },
    })}\r\n\r\n`
    const client = {
      async request(opts: { url: string; body?: string }): Promise<Response> {
        if (opts.url.includes("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "test-project" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        sent.push(opts.body ?? "")
        return new Response(frame, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      },
    }
    let text = ""
    for await (const ev of antigravityAdapter.run(titleRequest(), row("gemini-4-hydrogen"), {
      auth: { kind: "oauth", token: "test-token" },
      sessionId: "test-session",
      networkClient: client,
    } as never)) {
      if (ev.type === "text_delta") text += ev.text
    }
    const wire = JSON.parse(sent[0] ?? "{}") as Body
    expect(wire.request.generationConfig.responseMimeType).toBe("application/json")
    expect(wire.request.generationConfig.responseJsonSchema).toEqual(SCHEMA)
    expect(JSON.parse(text)).toEqual({ title: "Fix the login bug" })
  })
})

describe("structured outputs flag and validation", () => {
  const GEMINI_4 = ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon", "gemini-4-argon"]

  it("marks the Gemini 4 family rows, and validate accepts json_schema on them", () => {
    for (const id of GEMINI_4) {
      expect(row(id).capabilities.structuredOutputs).toBe(true)
      expect(validateAntigravityRequest(titleRequest(id), row(id)).ok).toBe(true)
    }
    // An old suffixed id resolves to the family row.
    expect(row("gemini-4-hydrogen-low").capabilities.structuredOutputs).toBe(true)
  })

  it("marks the Hydrogen row of a live catalog too", async () => {
    const file = new URL("./__fixtures__/fetch-available-models.json", import.meta.url)
    const catalog = (await Bun.file(file).json()) as CatalogResponse
    const hydrogen = antigravitySpecsFromCatalog(catalog).find((s) => s.id === "gemini-4-hydrogen")
    expect(hydrogen?.capabilities.structuredOutputs).toBe(true)
  })

  it("keeps the flag off on rows with no vendor proof, and validate rejects json_schema", () => {
    const unproven = [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "gpt-oss-120b-medium",
      "gemini-pro-orchestrator",
      "gemini-4-hydrogen-tiered-high",
      "gemini-4-hydrogen-sonar",
      "gemini-3.1-flash-image",
    ]
    for (const id of unproven) {
      expect(row(id).capabilities.structuredOutputs).toBe(false)
      expect(validateAntigravityRequest(titleRequest(id), row(id)).ok).toBe(false)
    }
  })

  it("sends no schema field for a row with the flag off", () => {
    const config = bodyOf(titleRequest("claude-sonnet-5-5"), row("claude-sonnet-5-5")).request
      .generationConfig
    expect(config).not.toHaveProperty("responseMimeType")
    expect(config).not.toHaveProperty("responseJsonSchema")
  })
})
