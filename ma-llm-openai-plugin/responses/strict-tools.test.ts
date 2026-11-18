/**
 * Strict function tools with nullable optional properties.
 *
 * The Responses API normalizes a tool with no `strict` key into strict mode by
 * itself, with no null on optional properties. The model then sends `""` for
 * an unused optional property (`Task {"id":""}` failed, research
 * 2026-11-17-session-1df63fe1-tool-input-loss). These tests pin the documented
 * strict form (each property required, each optional one nullable) and the
 * removal of those nulls from the call input.
 */
import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"

import { buildOpenAIResponsesBody } from "./request-body.ts"
import { type OpenAIResponsesEvent, translateOpenAIResponsesStream } from "./response-stream.ts"
import { dropOptionalNulls, strictToolSchemas, toStrictParameters } from "./strict-tools.ts"

/** The Bash tool schema as core sends it. */
const BASH = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    command: { type: "string" },
    timeout: { type: "number" },
    description: { type: "string" },
  },
  required: ["command"],
  additionalProperties: false,
}

describe("toStrictParameters", () => {
  it("makes each property required and each optional one nullable", () => {
    expect(toStrictParameters(BASH)).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: ["number", "null"] },
        description: { type: ["string", "null"] },
      },
      required: ["command", "timeout", "description"],
      additionalProperties: false,
    })
  })

  it("adds null to the enum of an optional enum property", () => {
    const out = toStrictParameters({
      type: "object",
      properties: { mode: { type: "string", enum: ["a", "b"] } },
      additionalProperties: false,
    })
    expect(out?.properties).toEqual({ mode: { type: ["string", "null"], enum: ["a", "b", null] } })
  })

  it("removes default, $schema and title, and keeps supported constraints", () => {
    const out = toStrictParameters({
      $schema: "x",
      type: "object",
      title: "T",
      properties: {
        n: { type: "integer", minimum: 0, default: 5 },
        flag: { type: "boolean", default: false },
      },
      required: ["n"],
      additionalProperties: false,
    })
    expect(out).toEqual({
      type: "object",
      properties: {
        n: { type: "integer", minimum: 0 },
        flag: { type: ["boolean", "null"] },
      },
      required: ["n", "flag"],
      additionalProperties: false,
    })
  })

  it("converts nested objects and typed array items", () => {
    const out = toStrictParameters({
      type: "object",
      properties: {
        order: { type: "array", items: { type: ["string", "integer"] } },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    })
    expect(out?.properties).toEqual({
      order: { type: ["array", "null"], items: { type: ["string", "integer"] } },
      tasks: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            tags: { type: ["array", "null"], items: { type: "string" } },
          },
          required: ["title", "tags"],
          additionalProperties: false,
        },
      },
    })
  })

  it("keeps a required property that already allows null as it is", () => {
    const out = toStrictParameters({
      type: "object",
      properties: { v: { type: ["string", "null"] } },
      required: ["v"],
      additionalProperties: false,
    })
    expect(out?.properties).toEqual({ v: { type: ["string", "null"] } })
  })

  it("does not change its input", () => {
    const copy = structuredClone(BASH)
    toStrictParameters(BASH)
    expect(BASH).toEqual(copy)
  })

  it("returns undefined for a schema it cannot make strict", () => {
    const freeObject = {
      type: "object",
      properties: { params: { type: "object", description: "any keys" } },
      additionalProperties: false,
    }
    const openObject = { type: "object", properties: {}, additionalProperties: true }
    // No `additionalProperties` key: JSON Schema allows other keys (open).
    const rootOmitted = { type: "object", properties: { x: { type: "string" } } }
    const nestedOmitted = {
      type: "object",
      properties: { o: { type: "object", properties: { y: { type: "string" } } } },
      additionalProperties: false,
    }
    const unsupported = {
      type: "object",
      properties: { x: { oneOf: [{ type: "string" }] } },
      additionalProperties: false,
    }
    const notObject = { type: "string" }
    // Any value (also null, an object or an array): no exact strict form.
    const untyped = {
      type: "object",
      properties: { value: { description: "any value" } },
      additionalProperties: false,
    }
    const arrayNoItems = {
      type: "object",
      properties: { order: { type: "array" } },
      additionalProperties: false,
    }
    // null is a real value here: "null" cannot also mean "not given".
    const optionalNullable = {
      type: "object",
      properties: { v: { type: ["string", "null"] } },
      additionalProperties: false,
    }
    const withConst = {
      type: "object",
      properties: { k: { type: "string", const: "x" } },
      additionalProperties: false,
    }
    const withAnyOf = {
      type: "object",
      properties: { p: { anyOf: [{ type: "string" }, { type: "number" }] } },
      additionalProperties: false,
    }
    const badRequired = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["missing"],
      additionalProperties: false,
    }
    for (const schema of [
      freeObject,
      openObject,
      rootOmitted,
      nestedOmitted,
      unsupported,
      notObject,
      untyped,
      arrayNoItems,
      optionalNullable,
      withConst,
      withAnyOf,
      badRequired,
      undefined,
      null,
    ]) {
      expect(toStrictParameters(schema)).toBeUndefined()
    }
  })
})

describe("dropOptionalNulls", () => {
  it("removes nulls of optional properties, at each depth", () => {
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, note: { type: "string" } },
            required: ["title"],
          },
        },
      },
      required: ["command"],
    }
    const input = {
      command: "ls",
      timeout: null,
      items: [{ title: "a", note: null }],
    }
    expect(dropOptionalNulls(input, schema)).toEqual({ command: "ls", items: [{ title: "a" }] })
    expect(input.timeout).toBeNull() // the input is not changed
  })

  it("keeps a null in a required property, a real value, and an unknown key", () => {
    const out = dropOptionalNulls({ command: null, timeout: 0, extra: null }, BASH)
    expect(out).toEqual({ command: null, timeout: 0, extra: null })
  })

  it("keeps an empty string: only null means absent", () => {
    expect(dropOptionalNulls({ command: "x", description: "" }, BASH)).toEqual({
      command: "x",
      description: "",
    })
  })
})

describe("buildOpenAIResponsesBody tools", () => {
  const model = {
    id: "gpt-test",
    surfaceId: "openai-responses",
    capabilities: { structuredOutputs: true, effort: { levels: [] }, modalities: { input: {} } },
  } as never
  const req = (tools: object[]) =>
    ({
      modelId: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools,
    }) as never

  it("sends a convertible tool as strict, with the converted schema", () => {
    const body = buildOpenAIResponsesBody(
      req([{ name: "Bash", description: "d", inputSchema: BASH }]),
      model,
    )
    expect(body.tools?.[0]).toEqual({
      type: "function",
      name: "Bash",
      description: "d",
      parameters: toStrictParameters(BASH) as object,
      strict: true,
    })
  })

  it("sends a tool unchanged when it opts out, or when it cannot be converted", () => {
    const free = {
      type: "object",
      properties: { params: { type: "object" } },
      additionalProperties: false,
    }
    const body = buildOpenAIResponsesBody(
      req([
        { name: "A", description: "d", inputSchema: BASH, strict: false },
        { name: "B", description: "d", inputSchema: free },
      ]),
      model,
    )
    expect(body.tools?.[0]).toMatchObject({ name: "A", parameters: BASH, strict: false })
    const toolB = body.tools?.[1] as { name: string; parameters: object; strict?: boolean }
    expect(toolB).toMatchObject({ name: "B", parameters: free })
    expect(toolB.strict).toBeUndefined()
  })
})

describe("strictToolSchemas", () => {
  it("lists the original schema of each tool sent as strict", () => {
    const map = strictToolSchemas([
      { name: "Bash", inputSchema: BASH },
      { name: "Off", inputSchema: BASH, strict: false },
      { name: "Free", inputSchema: { type: "object", properties: { p: { type: "object" } } } },
      { name: "web", server: "web_search" },
    ])
    expect([...map.keys()]).toEqual(["Bash"])
    expect(map.get("Bash")).toBe(BASH)
  })
})

describe("translateOpenAIResponsesStream with strict tools", () => {
  async function translate(events: object[], strict: Map<string, unknown>) {
    async function* src(): AsyncIterable<OpenAIResponsesEvent> {
      for (const e of events) yield e as OpenAIResponsesEvent
    }
    const out: CanonicalEvent[] = []
    for await (const e of translateOpenAIResponsesStream(src(), strict)) out.push(e)
    return out
  }
  // The exact argument text gpt-6.1-terra sent for a strict Bash tool (e2e).
  const args = '{"command": "echo hi", "timeout": null, "description": null}'
  const call = (deltas: string[]) => [
    { type: "response.created", response: { id: "r", model: "m" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "Bash", arguments: "" },
    },
    ...deltas.map((delta) => ({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_1",
      delta,
    })),
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_1",
      arguments: args,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "Bash", arguments: args },
    },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ]
  const strict = new Map<string, unknown>([["Bash", BASH]])
  const toolEvents = (events: CanonicalEvent[]) => events.filter((e) => e.type.startsWith("tool_"))

  for (const [label, deltas] of [
    ["streamed deltas", ['{"command": "echo hi", ', '"timeout": null, "description": null}']],
    ["no delta (parallel calls)", []],
  ] as const) {
    it(`drops the nulls of unused optional properties (${label})`, async () => {
      const events = toolEvents(await translate(call([...deltas]), strict))
      expect(events).toEqual([
        { type: "tool_use_start", index: 0, id: "call_1", name: "Bash" },
        { type: "tool_use_input_delta", index: 0, partialJson: '{"command":"echo hi"}' },
        { type: "tool_use_stop", index: 0, input: { command: "echo hi" } },
      ])
    })
  }

  it("uses the text of the deltas when output_item.done has no arguments", async () => {
    // Deltas only: no arguments.done, and an output_item.done with no text.
    const events: object[] = call([
      '{"command": "echo hi", ',
      '"timeout": null, "description": null}',
    ]).filter((e) => (e as { type: string }).type !== "response.function_call_arguments.done")
    const done = events.find((e) => (e as { type: string }).type === "response.output_item.done")
    ;(done as { item: { arguments: string } }).item.arguments = ""
    const out = toolEvents(await translate(events, strict))
    expect(out.at(-1)).toEqual({ type: "tool_use_stop", index: 0, input: { command: "echo hi" } })
  })

  it("leaves a tool that is not strict as before (raw deltas, nulls kept)", async () => {
    const events = toolEvents(await translate(call([args]), new Map()))
    expect(events).toEqual([
      { type: "tool_use_start", index: 0, id: "call_1", name: "Bash" },
      { type: "tool_use_input_delta", index: 0, partialJson: args },
      {
        type: "tool_use_stop",
        index: 0,
        input: { command: "echo hi", timeout: null, description: null },
      },
    ])
  })
})
