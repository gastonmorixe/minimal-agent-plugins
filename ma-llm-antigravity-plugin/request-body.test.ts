/**
 * Tests of the canonical to Cloud Code Assist request builder.
 *
 * Every rule here comes from a live probe of the real backend, recorded in
 * `research/2026-11-25-antigravity-plugin/logs/`:
 *
 * 1. `thoughtSignature` is a sibling of `functionCall`, never a child
 *    (`probe-tool-loop-20261125.log`: a child is 400 "Unknown name").
 * 2. A history that ends at a tool result needs a signature on the call, and
 *    the sentinel is the only safe filler
 *    (`probe-signature-ends-20261125.log`: unsigned ends 400, sentinel 200,
 *    corrupted base64 400).
 * 3. A `functionResponse` in `role:"user"` is 200 on all three families
 *    (`probe-tool-loop2-20261125.log`).
 *
 * @module request-body.test
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { CAPS_CLAUDE_VERTEX, CAPS_GEMINI_4, CAPS_GPT_OSS } from "./capabilities.ts"
import type { ModelView } from "./lib/host-types.ts"
import { PRICING_ANTIGRAVITY_PLAN } from "./pricing.ts"
import {
  type AntigravityBodyInput,
  antigravityFamily,
  buildAntigravityBody,
  buildGenerationConfig,
  THOUGHT_SIGNATURE_SENTINEL,
} from "./request-body.ts"

function model(id: string, caps = CAPS_GEMINI_4): ModelView {
  return {
    id,
    providerId: "antigravity",
    surfaceId: "custom",
    displayName: id,
    capabilities: caps,
    pricing: PRICING_ANTIGRAVITY_PLAN,
  }
}

const INPUT: AntigravityBodyInput = {
  project: "aicode-consumers",
  modelId: "gemini-4-neon-high",
  requestId: "agent/conv/1000000000000/exec/1",
  sessionId: "1000000000000000001",
}

const userText = (text: string): CanonicalMessage => ({
  role: "user",
  content: [{ type: "text", text }],
})

/** The `contents` array of a built body, with a loose type for the test. */
type Body = {
  project: string
  model: string
  requestType: string
  request: {
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
    systemInstruction?: { parts: Array<{ text: string }> }
    generationConfig: Record<string, unknown>
    tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
    toolConfig?: unknown
    sessionId?: string
  }
}

function build(req: Partial<CanonicalRequest>, input: Partial<AntigravityBodyInput> = {}): Body {
  const full: CanonicalRequest = { modelId: "gemini-4-neon-high", messages: [], ...req }
  return buildAntigravityBody(full, model(input.modelId ?? INPUT.modelId), {
    ...INPUT,
    ...input,
  }).body as Body
}

describe("antigravityFamily", () => {
  it("separates the three families by id prefix", () => {
    expect(antigravityFamily("gemini-4-neon-high")).toBe("gemini")
    expect(antigravityFamily("claude-opus-5-5-low")).toBe("claude")
    expect(antigravityFamily("gpt-oss-120b-medium")).toBe("gpt-oss")
  })
})

describe("buildAntigravityBody envelope", () => {
  it("builds the agy top-level fields", () => {
    const body = build({ messages: [userText("hi")] })
    expect(body.project).toBe("aicode-consumers")
    expect(body.model).toBe("gemini-4-neon-high")
    expect(body.requestType).toBe("agent")
    expect(body.request.sessionId).toBe("1000000000000000001")
  })

  it("puts the system blocks in systemInstruction, joined by a blank line", () => {
    const body = build({
      system: [
        { type: "text", text: "You are a helper." },
        { type: "text", text: "Be brief." },
      ],
      messages: [userText("hi")],
    })
    expect(body.request.systemInstruction?.parts[0].text).toBe("You are a helper.\n\nBe brief.")
  })

  it("turns a mid-conversation system message into a user part", () => {
    const body = build({
      messages: [userText("a"), { role: "system", content: [{ type: "text", text: "note" }] }],
    })
    expect(body.request.systemInstruction?.parts[0].text).toBe("note")
  })
})

describe("buildAntigravityBody tool results", () => {
  it("maps a tool message to role user with the tool name from the call", () => {
    const body = build({
      messages: [
        userText("read a"),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1001", name: "read_file", input: { Path: "a" } }],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_1001", content: [{ type: "text", text: "A" }] },
          ],
        },
      ],
      // No signature: the sentinel path must answer for the tail.
    })
    const last = body.request.contents.at(-1)
    expect(last?.role).toBe("user")
    expect(last?.parts[0]).toEqual({
      functionResponse: { id: "call_1001", name: "read_file", response: { output: "A" } },
    })
  })

  it("uses the error marker when a tool result has no text", () => {
    const body = build({
      messages: [
        userText("go"),
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "boom", input: {} }] },
        {
          role: "tool",
          content: [{ type: "tool_result", toolUseId: "c1", isError: true, content: [] }],
        },
      ],
    })
    const part = body.request.contents.at(-1)?.parts[0] as {
      functionResponse: { response: { output: string } }
    }
    expect(part.functionResponse.response.output).toBe("error")
  })

  // Regression, session 51282a5c (2026-11-27): core puts text that the host
  // queues during a tool round (a sub-agent completion digest, a mode or save
  // attachment) in the SAME user message as the tool results. The builder
  // sent only the functionResponse parts, so the lead never saw the digest
  // of A2 and waited for a worker that was done.
  // Evidence: research/2026-11-27-lost-subagent-digest/REPORT.md.
  it("keeps the text that follows a tool result in the same message", () => {
    const body = build({
      messages: [
        userText("audit"),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "SubAgentsAgentResult", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "c1",
              content: [{ type: "text", text: "A4 result" }],
            },
            { type: "text", text: "Sub-agent A3 finished" },
          ],
        },
      ],
    })
    const last = body.request.contents.at(-1)
    expect(last?.role).toBe("user")
    expect(last?.parts).toEqual([
      {
        functionResponse: {
          id: "c1",
          name: "SubAgentsAgentResult",
          response: { output: "A4 result" },
        },
      },
      { text: "Sub-agent A3 finished" },
    ])
  })

  it("puts every functionResponse first, then the text and media in order", () => {
    const body = build({
      messages: [
        userText("audit"),
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "c1", name: "SubAgentsAgentResult", input: { id: "A1" } },
            { type: "tool_use", id: "c2", name: "SubAgentsAgentResult", input: { id: "A3" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "A1" }] },
            { type: "text", text: "" },
            { type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "A3" }] },
            { type: "text", text: "Sub-agent A2 finished" },
            {
              type: "image",
              source: { kind: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    })
    const parts = body.request.contents.at(-1)?.parts ?? []
    expect(parts.map((p) => Object.keys(p)[0])).toEqual([
      "functionResponse",
      "functionResponse",
      "text",
      "inlineData",
    ])
    expect(parts[2]).toEqual({ text: "Sub-agent A2 finished" })
  })

  it("keeps the tail sentinel when text follows the tool result in the same message", () => {
    const body = build({
      messages: [
        userText("read a"),
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "A" }] },
            { type: "text", text: "note" },
          ],
        },
      ],
    })
    expect(body.request.contents[1].parts[0].thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
  })
})

describe("buildAntigravityBody thought signatures", () => {
  const toolMessages: CanonicalMessage[] = [
    userText("read a"),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1001", name: "read_file", input: { Path: "a" } }],
    },
    {
      role: "tool",
      content: [
        { type: "tool_result", toolUseId: "call_1001", content: [{ type: "text", text: "A" }] },
      ],
    },
  ]

  it("attaches the signature as a SIBLING of functionCall", () => {
    const body = build(
      { messages: toolMessages },
      { signatures: new Map([["call_1001", "SIG_ABC"]]) },
    )
    const callPart = body.request.contents[1].parts[0]
    expect(callPart).toEqual({
      functionCall: { id: "call_1001", name: "read_file", args: { Path: "a" } },
      thoughtSignature: "SIG_ABC",
    })
    expect(callPart.functionCall).not.toHaveProperty("thoughtSignature")
  })

  it("uses the sentinel on an unsigned call when history ends at a tool result", () => {
    const body = build({ messages: toolMessages })
    const callPart = body.request.contents[1].parts[0]
    expect(callPart.thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
  })

  it("sends no filler when user text follows the tool result", () => {
    const body = build({ messages: [...toolMessages, userText("now summarize")] })
    const callPart = body.request.contents[1].parts[0]
    expect(callPart).not.toHaveProperty("thoughtSignature")
  })

  it("takes the signature from an adjacent thinking block", () => {
    const body = build({
      messages: [
        userText("read a"),
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "I should read it.", signature: "SIG_FROM_THINKING" },
            { type: "tool_use", id: "call_2002", name: "read_file", input: { Path: "a" } },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_2002", content: [{ type: "text", text: "A" }] },
          ],
        },
      ],
    })
    expect(body.request.contents[1].parts[1].thoughtSignature).toBe("SIG_FROM_THINKING")
  })

  it("never adds a signature to a Claude or GPT-OSS call", () => {
    for (const [id, caps] of [
      ["claude-opus-5-5-low", CAPS_CLAUDE_VERTEX],
      ["gpt-oss-120b-medium", CAPS_GPT_OSS],
    ] as const) {
      const body = build({ messages: toolMessages }, { modelId: id })
      const callPart = body.request.contents[1].parts[0]
      expect(callPart).not.toHaveProperty("thoughtSignature")
      void caps
    }
  })
})

// Regression, session 51282a5c (2026-11-27): the adapter keeps signatures in
// memory only. After a restart in the middle of a turn, every earlier step was
// unsigned, the builder signed only the last one, and the backend answered 400
// "Function call is missing a thought_signature ... position 58". Gemini checks
// the FIRST functionCall of EACH step in the current turn. The turn starts
// after the newest user content that has no functionResponse.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
describe("buildAntigravityBody signatures after a lost cache", () => {
  const call = (id: string, name = "read_file"): CanonicalMessage => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  })
  const result = (id: string, text = "ok"): CanonicalMessage => ({
    role: "user",
    content: [{ type: "tool_result", toolUseId: id, content: [{ type: "text", text }] }],
  })
  const firstCall = (body: Body, index: number) =>
    body.request.contents[index].parts.find((p) => "functionCall" in p)

  it("signs the first call of every unsigned step of the current turn", () => {
    const body = build({
      messages: [userText("go"), call("c1"), result("c1"), call("c2"), result("c2")],
    })
    expect(firstCall(body, 1)?.thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
    expect(firstCall(body, 3)?.thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
  })

  it("puts the sentinel on the first call of a parallel step, not the last", () => {
    const body = build({
      messages: [
        userText("go"),
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "p1", name: "Edit", input: {} },
            { type: "tool_use", id: "p2", name: "Bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "p1", content: [{ type: "text", text: "a" }] },
            { type: "tool_result", toolUseId: "p2", content: [{ type: "text", text: "b" }] },
          ],
        },
      ],
    })
    const parts = body.request.contents[1].parts
    expect(parts[0].thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
    expect(parts[1]).not.toHaveProperty("thoughtSignature")
  })

  it("does not start a new turn at a user content with tool results and text", () => {
    const body = build({
      messages: [
        userText("go"),
        call("c1", "SubAgentsAgentResult"),
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "A4" }] },
            { type: "text", text: "Sub-agent A5 finished" },
          ],
        },
        call("c2"),
        result("c2"),
      ],
    })
    expect(firstCall(body, 1)?.thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
    expect(firstCall(body, 3)?.thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
  })

  it("keeps a real signature and leaves the steps of an earlier turn alone", () => {
    const body = build(
      {
        messages: [
          userText("old"),
          call("old1"),
          result("old1"),
          userText("new"),
          call("new1"),
          result("new1"),
        ],
      },
      { signatures: new Map([["new1", "SIG_NEW"]]) },
    )
    expect(firstCall(body, 1)).not.toHaveProperty("thoughtSignature")
    expect(firstCall(body, 4)?.thoughtSignature).toBe("SIG_NEW")
  })
})

describe("buildAntigravityBody tools", () => {
  it("declares tools with sanitized upper-case parameter types", () => {
    const body = build({
      messages: [userText("hi")],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: {
            type: "object",
            properties: { Path: { type: "string" } },
            required: ["Path"],
            additionalProperties: false,
          },
        },
      ],
    })
    const declaration = body.request.tools?.[0].functionDeclarations[0]
    expect(declaration?.parameters).toEqual({
      type: "OBJECT",
      properties: { Path: { type: "STRING" } },
      required: ["Path"],
    })
  })

  it("skips a server-hosted tool", () => {
    const body = build({
      messages: [userText("hi")],
      tools: [{ name: "web_search", description: "s", inputSchema: {}, server: "web_search" }],
    })
    expect(body.request.tools).toBeUndefined()
  })

  it("maps toolChoice any and a named tool to toolConfig", () => {
    const anyBody = build({ messages: [userText("hi")], toolChoice: { type: "any" } })
    expect(anyBody.request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } })
    const namedBody = build({
      messages: [userText("hi")],
      toolChoice: { type: "tool", name: "read_file" },
    })
    expect(namedBody.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] },
    })
    const autoBody = build({ messages: [userText("hi")], toolChoice: { type: "auto" } })
    expect(autoBody.request.toolConfig).toBeUndefined()
  })
})

describe("buildGenerationConfig", () => {
  it("clamps maxOutputTokens to the model limit", () => {
    const { generation } = buildGenerationConfig(
      { modelId: "gemini-4-neon-high", messages: [], generation: { maxOutputTokens: 999_999 } },
      model("gemini-4-neon-high"),
    )
    expect(generation.maxOutputTokens).toBe(262_144)
  })

  it("takes the thinking level from the model id suffix", () => {
    const { generation } = buildGenerationConfig(
      { modelId: "gemini-4-neon-high", messages: [] },
      model("gemini-4-neon-high"),
    )
    expect(generation.thinkingLevel).toBe("HIGH")
  })

  it("never sends a level that differs from the suffix of a single suffixed id", () => {
    // agy never sends gemini-4-neon-high with LOW (notes/effort-model-map.md A.5).
    const { generation } = buildGenerationConfig(
      { modelId: "gemini-4-neon-high", messages: [], effort: "low" },
      model("gemini-4-neon-high"),
    )
    expect(generation.thinkingLevel).toBe("HIGH")
  })

  it("omits the level when thinking is off", () => {
    const { config } = buildGenerationConfig(
      { modelId: "gemini-4-neon-high", messages: [], thinking: { mode: "off" } },
      model("gemini-4-neon-high"),
    )
    expect(config).not.toHaveProperty("thinkingConfig")
  })

  it("sends a numeric thinkingBudget to GPT-OSS, never a level", () => {
    const { config, generation } = buildGenerationConfig(
      { modelId: "gpt-oss-120b-medium", messages: [] },
      model("gpt-oss-120b-medium", CAPS_GPT_OSS),
    )
    const thinking = config.thinkingConfig as Record<string, unknown>
    expect(thinking.thinkingBudget).toBe(8192)
    expect(thinking).not.toHaveProperty("thinkingLevel")
    expect(generation.thinkingBudget).toBe(8192)
  })

  it("drops a sampling field the model does not accept", () => {
    const caps = { ...CAPS_GEMINI_4, acceptsTemperature: false }
    const { config } = buildGenerationConfig(
      { modelId: "gemini-4-neon-high", messages: [], generation: { temperature: 0.9 } },
      model("gemini-4-neon-high", caps),
    )
    expect(config).not.toHaveProperty("temperature")
  })
})
